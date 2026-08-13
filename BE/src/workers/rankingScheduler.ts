import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { findCurrentRankingSnapshot } from '../repositories/rankingRepository';

const logger = getLogger();

/**
 * Khoảng thời gian giữa các lần chạy scheduler (30 phút).
 * Lưu ý: với incremental update, scheduler không còn cần chạy mỗi 5 phút nữa.
 * Donation mới được cập nhật O(1) ngay khi được ghi nhận — không cần recalc toàn bộ.
 * Scheduler 30 phút chỉ để đảm bảo cache không bị stale quá lâu nếu có lỗi nào đó.
 */
const SCHEDULE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Ngưỡng thời gian tối đa (miligiây) mà cache được coi là "fresh".
 * Nếu cache đã cũ hơn ngưỡng này, scheduler sẽ invalidate để trigger rebuild từ incremental.
 */
const MAX_SNAPSHOT_AGE_MS = SCHEDULE_INTERVAL_MS;

/**
 * Hàm kiểm tra xem cache ranking có cần rebuild không.
 * Mục đích: với incremental metrics, chỉ cần invalidate cache khi nó quá cũ.
 * Incremental update đã cập nhật metrics O(1) rồi — scheduler chỉ dọn cache stale.
 *
 * @returns true nếu cần invalidate cache (không có snapshot HOẶC snapshot đã cũ).
 */
async function shouldInvalidateRankingCache(): Promise<boolean> {
  const latestSnapshot = await findCurrentRankingSnapshot();

  if (!latestSnapshot) {
    logger.info('Không có snapshot ranking. Scheduler sẽ invalidate cache để rebuild từ incremental.');
    return true;
  }

  const snapshotAge = Date.now() - latestSnapshot.calculatedAt.getTime();
  if (snapshotAge > MAX_SNAPSHOT_AGE_MS) {
    logger.info(`Snapshot ranking đã cũ (age=${Math.round(snapshotAge / 1000)}s). Scheduler sẽ invalidate cache.`);
    return true;
  }

  logger.info(`Snapshot ranking còn fresh (age=${Math.round(snapshotAge / 1000)}s). Bỏ qua scheduled invalidate.`);
  return false;
}

/**
 * Hàm khởi động scheduler cho bảng xếp hạng QF.
 * Mục đích: với incremental update, scheduler không còn cần recalc toàn bộ donations mỗi 5 phút.
 * Thay vào đó, chỉ invalidate cache khi nó quá cũ để rebuild từ incremental metrics.
 *
 * Flow:
 * 1. Scheduler chạy mỗi 30 phút bằng recursive setTimeout (thay vì setInterval)
 *    để tránh overlapping khi process bị treo hoặc job chạy lâu hơn interval.
 * 2. Kiểm tra xem cache còn fresh không.
 * 3. Nếu cache cũ hoặc không tồn tại → invalidate cache để GET /rankings rebuild.
 * 4. Reconcile worker (00:00 hàng ngày) xử lý drift prevention.
 *
 * Lưu ý: với incremental update, donation mới được cập nhật O(1) ngay khi ghi nhận.
 * Scheduler không còn cần enqueue job recalculate nữa — Bull queue ranking cũng không còn cần thiết.
 */
export function startRankingScheduler(): void {
  logger.info(`Ranking scheduler khởi động (interval=${SCHEDULE_INTERVAL_MS / 1000 / 60} phút, maxSnapshotAge=${MAX_SNAPSHOT_AGE_MS / 1000 / 60} phút).`);

  const runWithInterval = (): void => {
    setTimeout(async () => {
      await runWithWorkerContext('ranking-scheduler', async () => {
        try {
          const needInvalidate = await shouldInvalidateRankingCache();
          if (!needInvalidate) {
            runWithInterval();
            return;
          }

          const { invalidateRankingCache } = await import('../services/rankingCacheService');
          await invalidateRankingCache();

          logger.info('Scheduled ranking cache invalidated.');
        } catch (error) {
          logger.error('Scheduled ranking cache invalidation thất bại.', {
            errorMessage: (error as Error).message
          });
        }

        runWithInterval();
      });
    }, SCHEDULE_INTERVAL_MS);
  };

  runWithInterval();
}
