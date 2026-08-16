import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  archiveProjectEvents,
  createConfiguredEventArchiveStore,
  purgeArchivedRegularEvents,
  type ArchiveProjectEventsResult,
  type PurgeArchivedRegularEventsResult
} from '../services/event-archive.service';
import type { AuditArchiveStore } from '../services/adminAuditArchive.service';

const logger = getLogger();
const RETENTION_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const RETENTION_DRAIN_RETRY_INTERVAL_MS = 60_000;
const RETENTION_MAX_BATCHES_PER_RUN = 100;
const RETENTION_TIME_BUDGET_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let drainTimeoutId: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

export interface EventRetentionCycleResult {
  archive: ArchiveProjectEventsResult;
  purge: PurgeArchivedRegularEventsResult;
  hasMore: boolean;
}

/** Chạy một vòng archive và purge trong worker context để log có correlation riêng. */
export async function runEventRetentionOnce(store: AuditArchiveStore): Promise<EventRetentionCycleResult> {
  return runWithWorkerContext('event-retention', async () => {
    const archive = await archiveProjectEvents({
      store,
      maxBatches: RETENTION_MAX_BATCHES_PER_RUN,
      timeBudgetMs: RETENTION_TIME_BUDGET_MS
    });
    const purge = await purgeArchivedRegularEvents({
      store,
      maxBatches: RETENTION_MAX_BATCHES_PER_RUN,
      timeBudgetMs: RETENTION_TIME_BUDGET_MS
    });
    return { archive, purge, hasMore: archive.hasMore || purge.hasMore };
  });
}

/** Khởi động retention daily khi có gate và cold-storage config hợp lệ. */
export function startEventRetentionWorker(store?: AuditArchiveStore): void {
  if (intervalId) return;
  if (process.env.EVENT_ARCHIVE_ENABLED !== 'true') {
    logger.warn('Event retention worker chưa bật: EVENT_ARCHIVE_ENABLED khác "true".');
    return;
  }

  const archiveStore = store ?? createConfiguredEventArchiveStore();
  if (!archiveStore) {
    logger.error('Event retention worker không khởi động: thiếu cấu hình cold storage.');
    return;
  }

  void runScheduledRetentionOnce(archiveStore);
  intervalId = setInterval(() => {
    void runScheduledRetentionOnce(archiveStore);
  }, RETENTION_POLL_INTERVAL_MS);
}

/** Dừng interval và drain retry timeout khi backend shutdown graceful. */
export function stopEventRetentionWorker(): void {
  if (intervalId) clearInterval(intervalId);
  if (drainTimeoutId) clearTimeout(drainTimeoutId);
  intervalId = null;
  drainTimeoutId = null;
  isRunning = false;
}

/** Chạy retention không chồng chu kỳ và retry backlog sớm khi một vòng chưa drain hết. */
async function runScheduledRetentionOnce(store: AuditArchiveStore): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await runEventRetentionOnce(store);
    logger.info('Event retention worker hoàn tất chu kỳ.', {
      context: {
        scanned: result.archive.scanned + result.purge.scanned,
        archived: result.archive.archived,
        deleted: result.purge.deleted,
        failed: result.archive.failed + result.purge.failed,
        hasMore: result.hasMore
      }
    });
    if (result.hasMore && intervalId) {
      drainTimeoutId = setTimeout(() => {
        drainTimeoutId = null;
        void runScheduledRetentionOnce(store);
      }, RETENTION_DRAIN_RETRY_INTERVAL_MS);
    }
  } catch (error) {
    logger.error('Event retention worker lỗi query/chu kỳ.', {
      context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
    });
  } finally {
    isRunning = false;
  }
}

/** Reset state timer và lock cho test isolated. */
export function __resetEventRetentionWorkerState(): void {
  stopEventRetentionWorker();
}
