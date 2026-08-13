import { getLogger } from '../config/logger';
import {
  archiveAdminAuditLogs,
  createConfiguredAuditArchiveStore,
  type AuditArchiveStore,
  type ArchiveAdminAuditLogsResult
} from '../services/adminAuditArchive.service';

const logger = getLogger();
const ARCHIVE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_MAX_BATCHES_PER_RUN = 100;
const ARCHIVE_TIME_BUDGET_MS = 30_000;
const ARCHIVE_DRAIN_RETRY_INTERVAL_MS = 60_000;
const ARCHIVE_FAILURE_ALERT_THRESHOLD = 1;

let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/** Worker archive chạy daily, chỉ được bật rõ ràng qua AUDIT_ARCHIVE_ENABLED=true. */
export function startAdminAuditArchiveWorker(store?: AuditArchiveStore): void {
  if (intervalId || process.env.AUDIT_ARCHIVE_ENABLED !== 'true') return;

  const archiveStore = store ?? createConfiguredAuditArchiveStore();
  if (!archiveStore) {
    logger.error('Audit archive worker không khởi động: thiếu endpoint hoặc bearer credential.');
    return;
  }

  void runScheduledArchiveOnce(archiveStore);
  intervalId = setInterval(() => {
    void runScheduledArchiveOnce(archiveStore);
  }, ARCHIVE_POLL_INTERVAL_MS);
  logger.info('Admin audit archive worker đã khởi động.', {
    context: { pollIntervalMs: ARCHIVE_POLL_INTERVAL_MS }
  });
}

export function stopAdminAuditArchiveWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
  logger.info('Admin audit archive worker đã dừng.');
}

export async function runAdminAuditArchiveOnce(store: AuditArchiveStore): Promise<ArchiveAdminAuditLogsResult> {
  try {
    const result = await archiveAdminAuditLogs({
      store,
      maxBatches: ARCHIVE_MAX_BATCHES_PER_RUN,
      timeBudgetMs: ARCHIVE_TIME_BUDGET_MS
    });
    logger.info('Admin audit archive worker hoàn tất chu kỳ.', {
      context: {
        cutoff: result.cutoff,
        scanned: result.scanned,
        archived: result.archived,
        skipped: result.skipped,
        failed: result.failed,
        hasMore: result.hasMore,
        oldestHotCreatedAt: result.oldestHotCreatedAt,
        backlogAgeMs: result.backlogAgeMs
      }
    });
    if (result.failed >= ARCHIVE_FAILURE_ALERT_THRESHOLD || result.hasMore) {
      logger.warn('Admin audit archive backlog cần tiếp tục drain hoặc đang có lỗi.', {
        context: {
          failed: result.failed,
          hasMore: result.hasMore,
          oldestHotCreatedAt: result.oldestHotCreatedAt,
          backlogAgeMs: result.backlogAgeMs
        }
      });
    }
    return result;
  } catch (error) {
    logger.error('Admin audit archive worker lỗi query/chu kỳ.', {
      errorMessage: (error as Error).message
    });
    throw error;
  }
}

/** Không cho hai chu kỳ archive chồng lên nhau khi storage chậm hơn lịch poll. */
async function runScheduledArchiveOnce(store: AuditArchiveStore): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await runAdminAuditArchiveOnce(store);
    if (result.hasMore) {
      // Backlog còn lại cần được drain sớm, không chờ tới lịch daily tiếp theo.
      setTimeout(() => { void runScheduledArchiveOnce(store); }, ARCHIVE_DRAIN_RETRY_INTERVAL_MS);
    }
  } catch {
    // runAdminAuditArchiveOnce đã log chi tiết; scheduler chỉ cần giữ interval sống.
  } finally {
    isRunning = false;
  }
}
