import Queue from 'bull';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';

const logger = getLogger();
const rankingQueueName = 'ranking-recalculate';

/** Hàm tạo Bull queue cho ranking recalculate. Mục đích: cho phép đẩy job async vào hàng đợi thay vì blocking request. */
function createRankingQueue(): Queue.Queue<{ windowHours: number }> | null {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa sẵn sàng. Không thể tạo Bull queue cho ranking.');
    return null;
  }

  // Ghi chú logic phức tạp: Bull v3 overload — URL là arg thứ 2, options không chứa redis config.
  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  return new Queue<{ windowHours: number }>(rankingQueueName, redisUrl, {
    limiter: { max: 1, duration: 60_000 },
    defaultJobOptions: {
      removeOnComplete: 10,
      removeOnFail: 20,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 }
    }
  });
}

let cachedQueue: Queue.Queue<{ windowHours: number }> | null = null;

/** Hàm lấy queue singleton. Mục đích: tái sử dụng queue instance xuyên suốt ứng dụng. */
export function getRankingQueue(): Queue.Queue<{ windowHours: number }> | null {
  if (!cachedQueue) {
    cachedQueue = createRankingQueue();
  }
  return cachedQueue;
}

/**
 * Hàm extract message từ error object.
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

/** Hàm đẩy job recalculate ranking. Mục đích: trigger async recalculate mỗi khi donation mới được indexed. */
export async function enqueueRankingRecalculate(windowHours = 720): Promise<boolean> {
  const rankingQueue = getRankingQueue();
  if (!rankingQueue) {
    logger.warn('Ranking queue không khả dụng. Bỏ qua enqueue job.');
    return false;
  }

  try {
    const enqueuedJob = await rankingQueue.add({ windowHours });
    logger.info(`Ranking recalculate job enqueued (jobId=${enqueuedJob.id}, windowHours=${windowHours}).`);
    return true;
  } catch (error) {
    logger.error('Enqueue ranking recalculate job failed.', { errorMessage: extractErrorMessage(error) });
    return false;
  }
}
