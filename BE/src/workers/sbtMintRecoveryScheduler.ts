import { getLogger } from '../config/logger';
import { recoverStuckSbtMints } from '../services/sbtMintService';

/**
 * Khoảng thời gian chạy recovery (15 phút).
 * Tìm các record PENDING/SUBMITTED/FAILED quá lâu chưa có job để re-enqueue.
 */
const SBT_MINT_RECOVERY_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Số phút để xác định record "quá lâu" — record createdAt/updatedAt < now - STUCK_THRESHOLD_MINUTES
 * sẽ được coi là stuck và cần re-enqueue.
 *
 * [I4 fix] Đặt bằng SBT_MINT_RECOVERY_INTERVAL_MS (15 phút) để khớp với chu kỳ cron.
 * Lý do: nếu threshold > interval, record có thể nằm "stuck" cả cycle rồi mới được phát hiện,
 * dù worker đáng lẽ đáng được cơ hội retry sớm hơn.
 */
const STUCK_THRESHOLD_MINUTES = SBT_MINT_RECOVERY_INTERVAL_MS / 60_000;

/**
 * Khoảng cách tối thiểu giữa 2 lần chạy recovery (idempotency guard).
 * Tránh double-run nếu setTimeout bị early-fire.
 */
const MIN_RUN_INTERVAL_MS = SBT_MINT_RECOVERY_INTERVAL_MS;

const logger = getLogger();

/**
 * Timestamp (ms) của lần chạy cuối cùng.
 * Dùng để đảm bảo idempotency: không chạy 2 lần trong khoảng MIN_RUN_INTERVAL_MS.
 */
let lastRunTimestamp = 0;

/**
 * Kiểm tra Redis có sẵn sàng không trước khi chạy recovery.
 * Mục đích: tránh chạy recovery khi queue không tồn tại → waste resources.
 */
async function isRedisReady(): Promise<boolean> {
  try {
    const { getRedisClientIfReady } = await import('../config/redis');
    return getRedisClientIfReady() !== null;
  } catch {
    return false;
  }
}

/**
 * Khởi động cron recovery cho SBT mint jobs.
 * Mục đích: phát hiện và re-enqueue các job bị stuck do:
 * - Redis restart mất queue
 * - Worker crash giữa chừng
 * - Tx SUBMITTED quá lâu chưa confirm (tx stuck)
 *
 * Pattern: recursive setTimeout với idempotency guard (giống rankingReconcileWorker).
 * Chạy mỗi SBT_MINT_RECOVERY_INTERVAL_MS (15 phút).
 */
export function startSbtMintRecoveryScheduler(): void {
  logger.info('SBT mint recovery scheduler khởi động (chạy mỗi 15 phút).');

  const scheduleNextRecovery = (): void => {
    setTimeout(async () => {
      try {
        const now = Date.now();

        // Idempotency guard: đảm bảo 2 lần chạy cách nhau ít nhất MIN_RUN_INTERVAL_MS
        if (now - lastRunTimestamp < MIN_RUN_INTERVAL_MS) {
          logger.info('SBT mint recovery scheduler bị skip do chạy quá gần đây.', {
            lastRunAgoMs: now - lastRunTimestamp,
            minIntervalMs: MIN_RUN_INTERVAL_MS
          });
          scheduleNextRecovery();
          return;
        }

        // Kiểm tra Redis sẵn sàng
        const redisReady = await isRedisReady();
        if (!redisReady) {
          logger.warn('Redis chưa sẵn sàng — bỏ qua recovery cycle.');
          scheduleNextRecovery();
          return;
        }

        lastRunTimestamp = now;
        logger.info('SBT mint recovery scheduler bắt đầu kiểm tra stuck jobs.');

        const result = await recoverStuckSbtMints(STUCK_THRESHOLD_MINUTES);

        logger.info('SBT mint recovery scheduler hoàn tất cycle.', {
          candidatesFound: result.recovered,
          enqueued: result.enqueued > 0,
          thresholdMinutes: STUCK_THRESHOLD_MINUTES
        });
      } catch (error) {
        logger.error('SBT mint recovery scheduler thất bại.', {
          errorMessage: (error as Error).message
        });
      }

      scheduleNextRecovery();
    }, SBT_MINT_RECOVERY_INTERVAL_MS);
  };

  scheduleNextRecovery();
}
