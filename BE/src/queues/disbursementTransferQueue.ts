import Queue from 'bull';
import { createHash } from 'crypto';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';

const logger = getLogger();
const disbursementTransferQueueName = 'disbursement-transfer';

/**
 * Backoff delays cho retry PayOS transfer (tính bằng milliseconds).
 * Retry 1: 1 phút, Retry 2: 5 phút, Retry 3: 30 phút.
 * Tổng cộng 4 attempt: 1 attempt ban đầu và 3 lần retry.
 */
export const PAYOS_TRANSFER_RETRY_DELAYS_MS = [
  60_000,    // Retry 1: 1 phút
  300_000,   // Retry 2: 5 phút
  1_800_000  // Retry 3: 30 phút
] as const;

export type DisbursementTransferJobData = {
  requestId: string;
  attemptNumber: number;
  idempotencyKey: string;
};

export type DisbursementTransferJobResult = {
  success: boolean;
  transferId?: string;
  providerTransactionId?: string;
  status?: 'SUCCESS' | 'PROCESSING' | 'FAILED';
  errorMessage?: string;
  shouldManualReview?: boolean;
};

/**
 * Hàm tạo Bull queue cho disbursement transfer.
 * Mục đích: đẩy job transfer vào hàng đợi với retry logic tự động.
 */
function createDisbursementTransferQueue(): Queue.Queue<DisbursementTransferJobData> | null {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa khả dụng. Không thể tạo Bull queue cho disbursement transfer.');
    return null;
  }

  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

  // Ghi chú logic phức tạp: Bull v3 overload — URL là arg thứ 2, options không chứa redis config.
  // Retry logic được xử lý thủ công trong worker bằng job.moveToDelayed().
  return new Queue<DisbursementTransferJobData>(disbursementTransferQueueName, redisUrl, {
    limiter: { max: 5, duration: 10_000 }, // Tối đa 5 job mỗi 10 giây để tránh quá tải PayOS API
    defaultJobOptions: {
      removeOnComplete: 50,  // Giữ 50 job thành công để trace
      removeOnFail: 100,     // Giữ 100 job thất bại để debug DLQ
      attempts: 1           // Worker tự xử lý retry với delay cụ thể
    }
  });
}

let cachedQueue: Queue.Queue<DisbursementTransferJobData> | null = null;

/**
 * Hàm lấy queue singleton.
 * Mục đích: tái sử dụng queue instance xuyên suốt ứng dụng.
 */
export function getDisbursementTransferQueue(): Queue.Queue<DisbursementTransferJobData> | null {
  if (!cachedQueue) {
    cachedQueue = createDisbursementTransferQueue();
  }
  return cachedQueue;
}

/**
 * Hàm extract message từ error object.
 * Redis client error có thể là string hoặc object dạng {errorMessage: ''}.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message ?? (error as Record<string, unknown>).errorMessage;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

/** Tạo Bull job ID ổn định theo transfer chain để retry outbox không tạo duplicate job. */
export function getDisbursementTransferJobId(
  requestId: string,
  attemptNumber: number,
  idempotencyKey: string
): string {
  const fingerprint = createHash('sha256')
    .update(`${requestId}:${attemptNumber}:${idempotencyKey}`)
    .digest('hex');
  return `disbursement-transfer-${fingerprint}`;
}

/**
 * Hàm đẩy job transfer disbursement vào queue.
 * Mục đích: trigger PayOS transfer khi disbursement đạt APPROVED.
 * Job sẽ được retry tự động với exponential backoff.
 */
export async function enqueueDisbursementTransfer(
  requestId: string,
  attemptNumber: number,
  idempotencyKey: string,
  options?: {
    delay?: number; // Override delay (ms)
    priority?: number;
  }
): Promise<{ jobId: string | number | undefined; enqueued: boolean }> {
  const queue = getDisbursementTransferQueue();
  if (!queue) {
    logger.warn('Disbursement transfer queue không khả dụng. Bỏ qua enqueue job.', { requestId });
    return { jobId: undefined, enqueued: false };
  }

  const jobData: DisbursementTransferJobData = {
    requestId,
    attemptNumber,
    idempotencyKey
  };

  const jobOptions: Queue.JobOptions = {
    attempts: 1
  };

  if (options?.delay !== undefined) {
    jobOptions.delay = options.delay;
  }

  if (options?.priority !== undefined) {
    jobOptions.priority = options.priority;
  }
  const jobId = getDisbursementTransferJobId(requestId, attemptNumber, idempotencyKey);

  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      // Retry sau khi queue đã nhận job phải được coi là thành công, không enqueue lại.
      return { jobId: existingJob.id, enqueued: true };
    }
    const job = await queue.add(jobData, { ...jobOptions, jobId });
    logger.info('Disbursement transfer job enqueued.', {
      requestId,
      attemptNumber,
      idempotencyKey,
      jobId: job.id,
      delay: options?.delay ?? 0
    });
    return { jobId: job.id, enqueued: true };
  } catch (error) {
    const existingJob = await queue.getJob(jobId).catch(() => null);
    if (existingJob) return { jobId: existingJob.id, enqueued: true };
    logger.error('Enqueue disbursement transfer job thất bại.', {
      requestId,
      attemptNumber,
      errorMessage: extractErrorMessage(error)
    });
    return { jobId: undefined, enqueued: false };
  }
}

/**
 * Hàm lấy job đang xử lý cho một requestId.
 * Mục đích: kiểm tra xem có job nào đang chạy cho disbursement này không.
 */
export async function getActiveJobByRequestId(
  requestId: string
): Promise<Queue.Job<DisbursementTransferJobData> | null> {
  const queue = getDisbursementTransferQueue();
  if (!queue) return null;

  const activeJobs = await queue.getActive();
  return activeJobs.find(job => job.data.requestId === requestId) ?? null;
}

/**
 * Hàm đếm số job đang chờ (waiting + delayed) cho một requestId.
 * Mục đích: kiểm tra xem có job nào đang chờ retry không.
 */
export async function countPendingJobsByRequestId(
  requestId: string
): Promise<number> {
  const queue = getDisbursementTransferQueue();
  if (!queue) return 0;

  const [waitingJobs, delayedJobs] = await Promise.all([
    queue.getWaiting(),
    queue.getDelayed()
  ]);

  const allPendingJobs = [...waitingJobs, ...delayedJobs];
  return allPendingJobs.filter(job => job.data.requestId === requestId).length;
}

/**
 * Hàm xóa tất cả job đang chờ cho một requestId.
 * Mục đích: cleanup khi disbursement được xử lý thành công hoặc chuyển manual review.
 */
export async function removePendingJobsByRequestId(
  requestId: string,
  preserveJobId?: string | number
): Promise<number> {
  const queue = getDisbursementTransferQueue();
  if (!queue) return 0;

  const [waitingJobs, delayedJobs] = await Promise.all([
    queue.getWaiting(),
    queue.getDelayed()
  ]);

  const allPendingJobs = [...waitingJobs, ...delayedJobs];
  const matchingJobs = allPendingJobs.filter(job => (
    job.data.requestId === requestId
    && (preserveJobId === undefined || String(job.id) !== String(preserveJobId))
  ));

  const removePromises = matchingJobs.map(async (job): Promise<number> => {
    try {
      await job.remove();
      return 1;
    } catch {
      return 0;
    }
  });

  const results = await Promise.all(removePromises);
  const removedCount: number = results.reduce((sum, count) => sum + count, 0);

  if (removedCount > 0) {
    logger.info('Đã xóa pending jobs cho disbursement.', {
      requestId,
      removedCount
    });
  }

  return removedCount;
}
