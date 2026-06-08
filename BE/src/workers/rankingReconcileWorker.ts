import { getLogger } from '../config/logger';
import { reconcileAllProjectMetrics } from '../services/rankingIncrementalService';
import { runGuestCleanupOnce } from './guestCleanupWorker';

/**
 * Thời điểm chạy reconcile mỗi ngày: 00:00 (nửa đêm).
 * Đặt vào lúc ít người dùng nhất để giảm tải MongoDB khi full recompute.
 */
const RECONCILE_SCHEDULE_HOUR = 0;
const RECONCILE_SCHEDULE_MINUTE = 0;

/**
 * Cửa sổ thời gian tính toán QF (720 giờ = 30 ngày).
 * Dùng cùng giá trị với scheduler cũ để đảm bảo consistency.
 */
const DEFAULT_WINDOW_HOURS = 720;

/**
 * Khoảng cách tối thiểu giữa 2 lần chạy (12 giờ).
 * Dùng làm idempotency guard chống early-fire double-run.
 * 12 giờ đủ lớn để phân biệt 2 lần chạy cùng ngày.
 */
const MIN_RUN_INTERVAL_MS = 12 * 60 * 60 * 1000;

const logger = getLogger();

/**
 * Timestamp (ms) của lần chạy cuối cùng.
 * Dùng để đảm bảo idempotency: không chạy 2 lần trong khoảng MIN_RUN_INTERVAL_MS.
 */
let lastRunTimestamp = 0;

/**
 * Kiểm tra xem đã đến thời điểm chạy reconcile chưa (window-based).
 * Thay vì so sánh chính xác hours === 0 && minutes === 0,
 * hàm này kiểm tra trong khoảng [00:00, 00:01) — tức 60 giây đầu tiên của ngày.
 *
 * @returns true nếu đang trong window reconcile
 */
function isInReconcileWindow(): boolean {
  const now = new Date();
  return now.getHours() === RECONCILE_SCHEDULE_HOUR && now.getMinutes() === RECONCILE_SCHEDULE_MINUTE;
}

/**
 * Tính toán thời gian chờ (miligiây) đến thời điểm reconcile tiếp theo.
 * Mục đích: xác định delay để setTimeout tiếp theo rơi vào 00:00.
 *
 * @returns Số miligiây cần chờ đến thời điểm reconcile tiếp theo
 */
function calculateDelayUntilReconcileTime(): number {
  const now = new Date();
  const targetTime = new Date(now);
  targetTime.setHours(RECONCILE_SCHEDULE_HOUR, RECONCILE_SCHEDULE_MINUTE, 0, 0);

  // Nếu đã qua thời điểm hôm nay → lên lịch cho ngày mai
  if (targetTime <= now) {
    targetTime.setDate(targetTime.getDate() + 1);
  }

  return targetTime.getTime() - now.getTime();
}

/**
 * Khởi động reconcile worker cho bảng xếp hạng QF.
 * Mục đích: chạy full recompute cho TẤT CẢ projects mỗi ngày (00:00) để ngăn drift.
 *
 * Corrected Schedule Logic:
 * - Loại bỏ isReconcileTime() boolean check vì setTimeout không đảm bảo exact timing.
 * - Dùng timestamp-based idempotency guard: chỉ chạy nếu (now - lastRun) >= MIN_RUN_INTERVAL_MS.
 * - Điều này đảm bảo:
 *   (1) Late-fire: chạy muộn vẫn được thực thi (không bị skip vì đã qua 00:00)
 *   (2) Early-fire: không chạy 2 lần liên tiếp (guard chặn)
 *   (3) Missed: nếu bị skip hoàn toàn, ngày mai vẫn chạy bình thường
 *
 * So với approach cũ:
 *   - rankingScheduler: chạy mỗi 5 phút, query TOÀN BỘ donations → bottleneck
 *   - rankingReconcileWorker: chạy 1 lần/ngày, query donations THEO TỪNG PROJECT → O(P × D_project)
 *
 * Lưu ý:
 *   - Incremental update xử lý donation mới O(1) — không cần scheduler 5 phút.
 *   - Reconcile worker xử lý drift prevention — chạy 1 lần/ngày là đủ.
 *   - Dùng Promise.allSettled để cả 2 workers đều hoàn thành dù có lỗi.
 *     Log riêng kết quả success/failure của từng worker.
 */
export function startRankingReconcileWorker(): void {
  logger.info('Ranking reconcile worker khởi động (chạy 00:00 mỗi ngày).');

  // Hàm đệ quy để lên lịch reconcile tiếp theo
  const scheduleNextReconcile = (): void => {
    const delay = calculateDelayUntilReconcileTime();

    setTimeout(async () => {
      try {
        const now = Date.now();

        // Idempotency guard: đảm bảo 2 lần chạy cách nhau ít nhất 12 giờ
        // Chống early-fire double-run và late-fire skip
        if (now - lastRunTimestamp >= MIN_RUN_INTERVAL_MS) {
          lastRunTimestamp = now;
          logger.info('Ranking reconcile worker bắt đầu reconcile ngày.');

          // Dùng Promise.allSettled để cả 2 workers đều hoàn thành dù có lỗi
          const results = await Promise.allSettled([
            reconcileAllProjectMetrics(DEFAULT_WINDOW_HOURS),
            runGuestCleanupOnce()
          ]);

          // Log riêng kết quả success/failure của từng worker
          for (const result of results) {
            if (result.status === 'fulfilled') {
              logger.info(`Worker completed successfully: ${JSON.stringify(result.value)}`);
            } else {
              logger.error(`Worker failed: ${result.reason}`);
            }
          }

          logger.info('Ranking reconcile worker hoàn tất reconcile ngày.');
        } else {
          // Đã chạy gần đây (early-fire hoặc double trigger) → bỏ qua
          logger.info(`Ranking reconcile worker bị skip (last run: ${now - lastRunTimestamp}ms ago, min interval: ${MIN_RUN_INTERVAL_MS}ms).`);
        }
      } catch (error) {
        logger.error('Ranking reconcile worker thất bại.', {
          errorMessage: (error as Error).message
        });
      }

      // Lên lịch cho lần tiếp theo
      scheduleNextReconcile();
    }, delay);
  };

  scheduleNextReconcile();
}
