import Queue from 'bull';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';

const logger = getLogger();
const ORACLE_QUEUE_NAME = 'oracle-verification';

/**
 * Dữ liệu job xác minh ảnh minh chứng.
 * imageBuffer được encode base64 vì Bull serialize job data sang JSON.
 *
 * TODO: Lưu base64 ảnh 10MB vào Redis là anti-pattern (~13.3MB per job, concurrency=3 → ~40MB).
 * Khi IPFS fetch được hỗ trợ, thay imageBufferBase64 bằng evidenceCid và worker tự fetch từ IPFS
 * để tránh bão hòa Redis memory. Xem EvidenceUploadedEventPayload trong oracleEvents.ts.
 */
export type OracleVerificationJobData = {
  jobId: string;           // UUID — dùng để trace log
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  imageBufferBase64: string;  // Buffer.toString('base64')
  fileSizeBytes: number;
  disbursementRequestId?: string | null;  // Link để override request có thể auto-approve disbursement
};

export type OracleVerificationJobResult = {
  verificationId: string;
  isValid: boolean | null;
  distance: number | null;
  reason: string | null;
  overrideRequestId: string | null;
};

/**
 * Tạo Bull queue oracle-verification.
 * Concurrency 3: tránh overload CPU khi parse nhiều ảnh EXIF đồng thời.
 */
function createOracleQueue(): Queue.Queue<OracleVerificationJobData> | null {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa khả dụng. Không thể tạo oracle queue.');
    return null;
  }

  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

  return new Queue<OracleVerificationJobData>(ORACLE_QUEUE_NAME, redisUrl, {
    limiter: { max: 10, duration: 10_000 },
    defaultJobOptions: {
      removeOnComplete: 50,
      removeOnFail: 100,
      attempts: 2,  // 1 lần thử + 1 retry tự động nếu network/DB lỗi
      backoff: { type: 'exponential', delay: 5_000 }
    }
  });
}

let cachedQueue: Queue.Queue<OracleVerificationJobData> | null = null;

/** Lấy oracle queue singleton. */
export function getOracleQueue(): Queue.Queue<OracleVerificationJobData> | null {
  if (!cachedQueue) {
    cachedQueue = createOracleQueue();
  }
  return cachedQueue;
}

/** Đẩy job xác minh ảnh vào queue. */
export async function enqueueOracleVerification(
  data: OracleVerificationJobData
): Promise<{ jobId: string | number | undefined; enqueued: boolean }> {
  const queue = getOracleQueue();
  if (!queue) {
    logger.warn('Oracle queue không khả dụng.', { projectId: data.projectId });
    return { jobId: undefined, enqueued: false };
  }

  try {
    const job = await queue.add(data);
    logger.info('Oracle verification job enqueued.', {
      queueJobId: job.id,
      jobId: data.jobId,
      projectId: data.projectId,
      evidenceCid: data.evidenceCid,
      fileSizeBytes: data.fileSizeBytes
    });
    return { jobId: job.id, enqueued: true };
  } catch (error) {
    logger.error('Enqueue oracle verification job thất bại.', {
      jobId: data.jobId,
      projectId: data.projectId,
      errorMessage: (error as Error)?.message
    });
    return { jobId: undefined, enqueued: false };
  }
}
