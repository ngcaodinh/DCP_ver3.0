import Queue from 'bull';
import { createHash } from 'crypto';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';

const logger = getLogger();
const queueName = 'auditor-payout';

export const AUDITOR_PAYOUT_RETRY_DELAYS_MS = [120_000, 600_000, 3_600_000] as const;
export type AuditorPayoutJobData = {
  payoutId: string;
  attemptNumber: number;
  pollAttempt: number;
};

let cachedQueue: Queue.Queue<AuditorPayoutJobData> | null = null;

function getQueue(): Queue.Queue<AuditorPayoutJobData> | null {
  if (cachedQueue) return cachedQueue;
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa sẵn sàng; chưa thể enqueue chi trả cho Kiểm toán viên.');
    return null;
  }
  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  cachedQueue = new Queue<AuditorPayoutJobData>(queueName, redisUrl, {
    limiter: { max: 3, duration: 10_000 },
    defaultJobOptions: { removeOnComplete: 50, removeOnFail: 100, attempts: 1 }
  });
  return cachedQueue;
}

export function getAuditorPayoutQueue(): Queue.Queue<AuditorPayoutJobData> | null {
  return getQueue();
}

/** Enqueue payout theo attempt; idempotency key luôn đọc từ record để retry cũ không ghi đè key mới. */
export async function enqueueAuditorPayout(
  payoutId: string,
  attemptNumber: number = 1,
  options?: { delay?: number; pollAttempt?: number }
): Promise<boolean> {
  const queue = getQueue();
  if (!queue) return false;
  const pollAttempt = options?.pollAttempt ?? 0;
  const jobId = `auditor-payout-${createHash('sha256').update(`${payoutId}:${attemptNumber}:${pollAttempt}`).digest('hex')}`;
  try {
    const existing = await queue.getJob(jobId);
    if (existing) return true;
    await queue.add({ payoutId, attemptNumber, pollAttempt }, { jobId, delay: options?.delay, attempts: 1 });
    return true;
  } catch (error) {
    logger.error('Không thể enqueue chi trả cho Kiểm toán viên.', { payoutId, errorMessage: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function __resetAuditorPayoutQueueState(): void {
  cachedQueue = null;
}
