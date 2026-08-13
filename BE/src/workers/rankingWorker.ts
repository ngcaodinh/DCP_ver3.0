import { Job } from 'bull';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { getRankingQueue } from '../queues/rankingQueue';
import { recalculateRankingSnapshot } from '../services/rankingService';
import { invalidateRankingCache } from '../services/rankingCacheService';

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

const logger = getLogger();

/** Hàm khởi động worker xử lý job recalculate ranking. Mục đích: consume job từ Bull queue và chạy QF recalculation async. */
export function startRankingWorker(): void {
  const rankingQueue = getRankingQueue();
  if (!rankingQueue) {
    logger.warn('Ranking queue không khả dụng. Worker không khởi động được.');
    return;
  }

  rankingQueue.process(async (job: Job<{ windowHours: number }>) => {
    return runWithWorkerContext('ranking', async () => {
      const windowHours = job.data.windowHours ?? 720;
      logger.info('Ranking worker bắt đầu xử lý job.');

      try {
        // Ghi chú logic phức tạp: gọi recalculate trực tiếp từ service để đảm bảo tái sử dụng business logic đã có.
        await recalculateRankingSnapshot(windowHours);

        // Ghi chú logic phức tạp: sau recalculate thành công, xóa cache để GET /rankings trả dữ liệu mới.
        await invalidateRankingCache();

        logger.info('Ranking worker hoàn thành xử lý job.');
      } catch (error) {
        logger.error('Ranking worker xử lý job thất bại.', {
          errorMessage: extractErrorMessage(error)
        });
        throw error;
      }
    }, job.id);
  });

  rankingQueue.on('failed', (job: Job<{ windowHours: number }> | null, error: Error) => {
    runWithWorkerContext('ranking', () => {
      logger.error('Ranking job thất bại sau khi retry.', {
        errorMessage: error.message
      });
    }, job?.id);
  });

  rankingQueue.on('completed', (job: Job<{ windowHours: number }>) => {
    runWithWorkerContext('ranking', () => {
      logger.info('Ranking job hoàn thành.');
    }, job.id);
  });

  logger.info('Ranking worker đã khởi động.');
}
