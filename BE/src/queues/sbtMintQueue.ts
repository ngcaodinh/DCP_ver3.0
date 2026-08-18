import Queue from 'bull';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { extractErrorMessage } from '../utils/extractErrorMessage';

const logger = getLogger();
const sbtMintQueueName = 'sbt-mint';

/**
 * Backoff delays cho retry mint SBT (tính bằng milliseconds).
 * Theo spec C2: 6 lần retry sau attempt đầu, với backoff tăng dần để chờ network/RPC recover.
 * - 3 retry đầu: 5 phút, 15 phút, 60 phút (network issue ngắn hạn)
 * - 3 retry sau: 1 giờ, 4 giờ, 24 giờ (RPC provider hoặc indexer lâu recover)
 * Tổng tối đa 7 attempt (1 attempt đầu + 6 retry), sau đó vào DLQ.
 */
export const SBT_MINT_RETRY_DELAYS_MS = [
  5 * 60_000,        // Retry 1: 5 phút
  15 * 60_000,       // Retry 2: 15 phút
  60 * 60_000,       // Retry 3: 60 phút (1 giờ)
  60 * 60_000 * 1,   // Retry 4: 1 giờ
  60 * 60_000 * 4,   // Retry 5: 4 giờ
  60 * 60_000 * 24   // Retry 6: 24 giờ
] as const;

/**
 * Tổng số retry tối đa — nếu vượt quá → chuyển DLQ.
 * Phải khớp với độ dài SBT_MINT_RETRY_DELAYS_MS.
 */
export const SBT_MINT_MAX_ATTEMPTS = SBT_MINT_RETRY_DELAYS_MS.length + 1;

/**
 * Ngưỡng thời gian để xác định tx bị stuck (5 phút).
 * Nếu tx SUBMITTED quá thời gian này, controller chỉ cảnh báo để operator theo dõi.
 * Reconciler là thành phần duy nhất quyết định trạng thái dựa trên receipt; không auto-fail theo đồng hồ.
 */
export const SBT_MINT_STUCK_TX_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Payload cho mỗi SBT mint job.
 * Mục đích: truyền dữ liệu cần thiết để worker gọi mint() on-chain.
 *
 * - mintRequestId: idempotency key — mỗi Oracle verification chỉ tạo 1 mint request
 * - sbtId: liên kết tới impact_sbt_metadata record
 * - attemptNumber: attempt hiện tại (1-indexed) để tính delay backoff khi retry
 * - enqueuedBy: 'oracle_event' | 'cron_recovery' | 'admin_rerun' — cho audit log
 */
export type SbtMintJobData = {
  mintRequestId: string;
  sbtId: string;
  attemptNumber: number;
  enqueuedBy: 'oracle_event' | 'cron_recovery' | 'admin_rerun' | 'worker_retry';
};

export type SbtMintJobResult = {
  sbtId: string;
  mintRequestId: string;
  onChainTokenId: number | null;
  transactionHash: string | null;
  blockNumber: number | null;
  status: 'CONFIRMED' | 'SUBMITTED' | 'FAILED' | 'DLQ';
  attemptNumber: number;
};

/**
 * Hàm tạo Bull queue cho SBT mint.
 * Mục đích: cung cấp hàng đợi async với retry pattern tùy chỉnh.
 * Lưu ý: attempts=1 vì worker tự quản lý retry qua moveToDelayed với delays cụ thể.
 * Tránh dùng Bull built-in backoff vì ta cần 2 phase khác nhau (5m→15m→60m và 1h→4h→24h).
 */
function createSbtMintQueue(): Queue.Queue<SbtMintJobData> | null {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa sẵn sàng. Không thể tạo Bull queue cho SBT mint.');
    return null;
  }

  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  return new Queue<SbtMintJobData>(sbtMintQueueName, redisUrl, {
    limiter: { max: 3, duration: 10_000 },
    maxStalledCount: 2,
    stalledInterval: 30_000,
    defaultJobOptions: {
      removeOnComplete: 50,
      removeOnFail: 100,
      attempts: 1
    }
  } as Parameters<typeof Queue>[2]);
}

let cachedQueue: Queue.Queue<SbtMintJobData> | null = null;

/**
 * Hàm lấy queue singleton.
 * Mục đích: tái sử dụng instance xuyên suốt ứng dụng.
 */
export function getSbtMintQueue(): Queue.Queue<SbtMintJobData> | null {
  if (!cachedQueue) {
    cachedQueue = createSbtMintQueue();
  }
  return cachedQueue;
}

/**
 * Hàm đẩy job mint SBT vào queue.
 * Mục đích: trigger mint từ Oracle event / cron recovery / admin re-run.
 *
 * @param options.delay — override delay (ms), dùng cho retry backoff
 * @param options.priority — priority cho job (thấp = chạy trước)
 */
export async function enqueueSbtMint(
  jobData: SbtMintJobData,
  options?: { delay?: number; priority?: number }
): Promise<{ jobId: string | number | undefined; enqueued: boolean }> {
  const queue = getSbtMintQueue();
  if (!queue) {
    logger.warn('SBT mint queue không khả dụng. Bỏ qua enqueue job.', {
      mintRequestId: jobData.mintRequestId
    });
    return { jobId: undefined, enqueued: false };
  }

  const jobOptions: Queue.JobOptions = { attempts: 1 };
  if (options?.delay !== undefined) jobOptions.delay = options.delay;
  if (options?.priority !== undefined) jobOptions.priority = options.priority;
  const jobId = `${jobData.mintRequestId}-attempt${jobData.attemptNumber}`;

  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const existingState = await existingJob.getState();
      if (['waiting', 'delayed', 'active', 'paused'].includes(existingState)) {
        // Retry outbox sau khi queue đã nhận job phải được coi là thành công, không tạo audit failure giả.
        return { jobId: existingJob.id, enqueued: true };
      }

      // Bull giữ lại job completed/failed theo removeOnComplete/removeOnFail; các job terminal này
      // không còn được worker xử lý và không được phép chặn admin rerun hoặc durable replay.
      if (existingState === 'completed' || existingState === 'failed') {
        await existingJob.remove();
      }
    }
    const job = await queue.add(jobData, { ...jobOptions, jobId });
    logger.info('SBT mint job enqueued.', {
      mintRequestId: jobData.mintRequestId,
      sbtId: jobData.sbtId,
      attemptNumber: jobData.attemptNumber,
      enqueuedBy: jobData.enqueuedBy,
      jobId: job.id,
      delay: options?.delay ?? 0
    });
    return { jobId: job.id, enqueued: true };
  } catch (error) {
    // Race giữa hai producer: job cố định đã được producer khác tạo thì vẫn là dispatch thành công.
    const existingJob = await queue.getJob(jobId).catch(() => null);
    if (existingJob) {
      const existingState = await existingJob.getState().catch(() => null);
      if (existingState && ['waiting', 'delayed', 'active', 'paused'].includes(existingState)) {
        return { jobId: existingJob.id, enqueued: true };
      }
    }
    logger.error('Enqueue SBT mint job thất bại.', {
      mintRequestId: jobData.mintRequestId,
      sbtId: jobData.sbtId,
      errorMessage: extractErrorMessage(error)
    });
    return { jobId: undefined, enqueued: false };
  }
}

/**
 * Hàm đếm số job đang chờ (waiting + delayed) cho một mintRequestId.
 * Mục đích: tránh enqueue duplicate khi admin click re-run nhiều lần.
 */
export async function countPendingSbtMintJobsByRequestId(mintRequestId: string): Promise<number> {
  const queue = getSbtMintQueue();
  if (!queue) return 0;
  const jobs = await getDeterministicSbtMintJobs(queue, mintRequestId);
  let pendingCount = 0;
  for (const job of jobs) {
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'active') pendingCount += 1;
  }
  return pendingCount;
}

/**
 * Hàm xóa tất cả job pending cho một mintRequestId.
 * Mục đích: dọn dẹp khi admin re-run — đảm bảo chỉ có 1 job retry đang chờ.
 */
export async function removePendingSbtMintJobsByRequestId(mintRequestId: string): Promise<number> {
  const queue = getSbtMintQueue();
  if (!queue) return 0;

  // Lưu ý: CHỈ remove waiting + delayed, KHÔNG remove active.
  // Active jobs đang chạy (processSbtMintJob đang thực thi) — remove sẽ corrupt queue state
  // và có thể gây double-mint. Nếu job active đang xử lý fail, nó sẽ tự retry qua Bull's
  // built-in mechanism. Recovery scheduler cũng đã skip records có job active.
  //
  // [N-B1] Giới hạn fetch 100 jobs mỗi loại — tránh O(n) scan khi queue lớn.
  // Thực tế: mỗi mintRequestId chỉ có tối đa 1-2 pending job tại bất kỳ thời điểm nào
  // (do BullMQ limiter max 3 jobs/10s). Limit 100 chỉ là safety cap.
  const matchingJobs = [];
  for (const job of await getDeterministicSbtMintJobs(queue, mintRequestId)) {
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') matchingJobs.push(job);
  }

  const removeResults = await Promise.all(
    matchingJobs.map(async (job): Promise<number> => {
      try {
        await job.remove();
        return 1;
      } catch {
        return 0;
      }
    })
  );
  const removedCount: number = removeResults.reduce((sum, n) => sum + n, 0);

  if (removedCount > 0) {
    logger.info('Đã xóa pending SBT mint jobs.', {
      mintRequestId,
      removedCount
    });
  }
  return removedCount;
}

/** Lấy các job theo ID deterministic trong bounded attempt range, không scan queue toàn cục. */
async function getDeterministicSbtMintJobs(
  queue: Queue.Queue<SbtMintJobData>,
  mintRequestId: string
): Promise<Queue.Job<SbtMintJobData>[]> {
  const jobs = await Promise.all(
    Array.from({ length: SBT_MINT_MAX_ATTEMPTS }, (_, index) =>
      queue.getJob(`${mintRequestId}-attempt${index + 1}`)
    )
  );
  return jobs.filter((job): job is Queue.Job<SbtMintJobData> => Boolean(job));
}
