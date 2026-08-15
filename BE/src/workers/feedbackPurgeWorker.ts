import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  purgeSoftDeletedFeedback,
  type PurgeSoftDeletedFeedbackResult
} from '../services/feedbackPurge.service';

const logger = getLogger();
const PURGE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PURGE_MAX_BATCHES_PER_RUN = 100;
const PURGE_TIME_BUDGET_MS = 30_000;
const PURGE_DRAIN_RETRY_INTERVAL_MS = 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let drainTimeoutId: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

/** Worker purge chạy daily, chỉ bật rõ ràng qua FEEDBACK_PURGE_ENABLED=true. */
export function startFeedbackPurgeWorker(): void {
  if (intervalId) return;
  if (process.env.FEEDBACK_PURGE_ENABLED !== 'true') {
    logger.warn('Feedback purge worker chưa bật: FEEDBACK_PURGE_ENABLED khác "true". Feedback đã xoá mềm sẽ được giữ vô thời hạn.');
    return;
  }

  void runScheduledPurgeOnce();
  intervalId = setInterval(() => {
    void runScheduledPurgeOnce();
  }, PURGE_POLL_INTERVAL_MS);
  logger.info('Feedback purge worker đã khởi động.', {
    context: { pollIntervalMs: PURGE_POLL_INTERVAL_MS }
  });
}

/** Dừng lịch purge khi backend shutdown graceful. */
export function stopFeedbackPurgeWorker(): void {
  if (intervalId) clearInterval(intervalId);
  if (drainTimeoutId) clearTimeout(drainTimeoutId);
  intervalId = null;
  drainTimeoutId = null;
  logger.info('Feedback purge worker đã dừng.');
}

/** Chạy một vòng purge trong request context riêng để test và vận hành thủ công. */
export async function runFeedbackPurgeOnce(): Promise<PurgeSoftDeletedFeedbackResult> {
  return runWithWorkerContext('feedback-purge', runFeedbackPurgeOnceInternal);
}

/** Thực thi purge có log bounded, không ghi comment, ID hay dữ liệu nhận diện từng bản ghi. */
async function runFeedbackPurgeOnceInternal(): Promise<PurgeSoftDeletedFeedbackResult> {
  try {
    const result = await purgeSoftDeletedFeedback({
      maxBatches: PURGE_MAX_BATCHES_PER_RUN,
      timeBudgetMs: PURGE_TIME_BUDGET_MS
    });
    logger.info('Feedback purge worker hoàn tất chu kỳ.', {
      context: {
        cutoff: result.cutoff,
        scanned: result.scanned,
        purged: result.purged,
        hasMore: result.hasMore
      }
    });
    return result;
  } catch (error) {
    logger.error('Feedback purge worker lỗi query/chu kỳ.', {
      errorMessage: error instanceof Error ? error.message : 'Unknown purge error'
    });
    throw error;
  }
}

/** Không cho hai chu kỳ purge chồng lên nhau; backlog sẽ drain sau 60 giây. */
async function runScheduledPurgeOnce(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await runFeedbackPurgeOnce();
    if (result.hasMore && intervalId) {
      drainTimeoutId = setTimeout(() => {
        drainTimeoutId = null;
        void runScheduledPurgeOnce();
      }, PURGE_DRAIN_RETRY_INTERVAL_MS);
    }
  } catch {
    // runFeedbackPurgeOnce đã ghi log bounded; scheduler giữ interval sống cho chu kỳ kế tiếp.
  } finally {
    isRunning = false;
  }
}
