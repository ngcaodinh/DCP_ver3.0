import { getLogger } from '../config/logger';
import {
  createConfiguredAuditArchiveStore,
  getCalendarYearCutoff,
  sha256,
  type AuditArchiveStore
} from './adminAuditArchive.service';
import {
  deleteArchivedEventsOlderThan,
  findArchivedRegularEventsOlderThan,
  findHotEventsOlderThan,
  markProjectEventArchived
} from '../models/projectEventModel';
import {
  IMMUTABLE_EVENT_TYPES,
  PROJECT_EVENT_TYPES,
  isImmutableProjectEventType,
  type ProjectEventType
} from '../constants/projectEventTypes';
import type { ProjectEventRecord } from '../types/project-event.types';

const logger = getLogger();
const DEFAULT_ARCHIVE_BATCH_SIZE = 500;
const DEFAULT_ARCHIVE_MAX_BATCHES = 100;
const DEFAULT_ARCHIVE_TIME_BUDGET_MS = 30_000;
const ARCHIVE_PREFIX = 'project-events';
const ARCHIVE_CONCURRENCY = 8;
const PURGE_VERIFY_CONCURRENCY = 8;
const REGULAR_EVENT_TYPES = PROJECT_EVENT_TYPES.filter(
  (eventType): eventType is ProjectEventType => !isImmutableProjectEventType(eventType)
);

export interface ArchiveProjectEventsOptions {
  store: AuditArchiveStore;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
}

export interface ArchiveProjectEventsResult {
  regularCutoff: Date;
  immutableCutoff: Date;
  scanned: number;
  archived: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
  oldestHotTimestamp: Date | null;
  backlogAgeMs: number | null;
}

export interface PurgeArchivedRegularEventsOptions {
  store: AuditArchiveStore;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
}

export interface PurgeArchivedRegularEventsResult {
  cutoff: Date;
  scanned: number;
  deleted: number;
  failed: number;
  hasMore: boolean;
}

type ArchiveOneOutcome = 'archived' | 'skipped' | 'failed';

/** Chuẩn hóa option archive thành giới hạn an toàn để worker không tạo batch ngoài kiểm soát. */
function normalizeBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}

/** Đóng gói record canonical cho cold storage, không dump các field nội bộ của Mongoose. */
export function serializeProjectEventRecord(record: ProjectEventRecord): Buffer {
  return Buffer.from(`${JSON.stringify({
    eventId: record.eventId,
    eventType: record.eventType,
    projectId: record.projectId,
    timestamp: new Date(record.timestamp).toISOString(),
    walletAddress: record.walletAddress,
    amount: record.amount,
    correlationId: record.correlationId,
    organizationId: record.organizationId,
    payload: record.payload,
    source: record.source,
    archiveState: record.archiveState,
    createdAt: new Date(record.createdAt).toISOString()
  })}\n`, 'utf8');
}

/** Tạo locator ổn định theo thời điểm event, tách biệt hoàn toàn với prefix audit của E8. */
export function buildProjectEventArchiveLocator(eventId: string, timestamp: Date): string {
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  return `${ARCHIVE_PREFIX}/${year}/${month}/${encodeURIComponent(eventId)}.json`;
}

/** Upload, verify checksum và chuyển một event HOT sang ARCHIVED theo thứ tự an toàn. */
async function archiveOneProjectEvent(
  record: ProjectEventRecord,
  archivedAt: Date,
  store: AuditArchiveStore
): Promise<ArchiveOneOutcome> {
  if (!record.eventId || !record.timestamp) return 'skipped';
  const payload = serializeProjectEventRecord(record);
  const checksum = sha256(payload);
  const locator = buildProjectEventArchiveLocator(record.eventId, record.timestamp);

  try {
    await store.putImmutable(locator, payload, checksum);
    if (!await store.verify(locator, checksum)) {
      throw new Error('Archive checksum verification failed.');
    }

    const marked = await markProjectEventArchived(record.eventId, archivedAt, locator, checksum);
    return marked ? 'archived' : 'skipped';
  } catch (error) {
    logger.error('Archive project event thất bại; record sẽ được retry.', {
      context: {
        eventId: record.eventId,
        eventType: record.eventType,
        errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
      }
    });
    return 'failed';
  }
}

/** Xử lý một batch với concurrency bounded để không tạo quá nhiều request cold storage. */
async function archiveBatch(
  records: ProjectEventRecord[],
  archivedAt: Date,
  store: AuditArchiveStore
): Promise<{ archived: number; skipped: number; failed: number }> {
  let archived = 0;
  let skipped = 0;
  let failed = 0;
  for (let offset = 0; offset < records.length; offset += ARCHIVE_CONCURRENCY) {
    const outcomes = await Promise.all(records.slice(offset, offset + ARCHIVE_CONCURRENCY)
      .map(record => archiveOneProjectEvent(record, archivedAt, store)));
    archived += outcomes.filter(outcome => outcome === 'archived').length;
    skipped += outcomes.filter(outcome => outcome === 'skipped').length;
    failed += outcomes.filter(outcome => outcome === 'failed').length;
  }
  return { archived, skipped, failed };
}

/** Archive regular sau 90 ngày và event bất biến sau một calendar year, không dùng TTL index. */
export async function archiveProjectEvents(
  options: ArchiveProjectEventsOptions
): Promise<ArchiveProjectEventsResult> {
  const now = options.now ?? new Date();
  const regularCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000);
  const immutableCutoff = getCalendarYearCutoff(now);
  const batchSize = normalizeBoundedInteger(options.batchSize, DEFAULT_ARCHIVE_BATCH_SIZE, 5_000);
  const maxBatches = normalizeBoundedInteger(options.maxBatches, DEFAULT_ARCHIVE_MAX_BATCHES, 1_000);
  const timeBudgetMs = normalizeBoundedInteger(options.timeBudgetMs, DEFAULT_ARCHIVE_TIME_BUDGET_MS, 300_000);
  const result: ArchiveProjectEventsResult = {
    regularCutoff,
    immutableCutoff,
    scanned: 0,
    archived: 0,
    skipped: 0,
    failed: 0,
    hasMore: false,
    oldestHotTimestamp: null,
    backlogAgeMs: null
  };
  const startedAt = Date.now();
  const policies: Array<{ cutoff: Date; eventTypes: readonly ProjectEventType[] }> = [
    { cutoff: regularCutoff, eventTypes: REGULAR_EVENT_TYPES },
    { cutoff: immutableCutoff, eventTypes: IMMUTABLE_EVENT_TYPES }
  ];
  let batchCount = 0;
  const activePolicies = policies.map(policy => ({ policy, hasMore: true }));

  // Round-robin regular va immutable de tranh starvation immutable backlog.
  while (batchCount < maxBatches && activePolicies.some(item => item.hasMore)) {
    let processedBatch = false;
    for (const activePolicy of activePolicies) {
      if (!activePolicy.hasMore || batchCount >= maxBatches) break;
      if (batchCount > 0 && Date.now() - startedAt >= timeBudgetMs) {
        result.hasMore = true;
        break;
      }

      const records = await findHotEventsOlderThan(
        activePolicy.policy.cutoff,
        activePolicy.policy.eventTypes,
        batchSize
      );
      if (records.length === 0) {
        activePolicy.hasMore = false;
        continue;
      }

      processedBatch = true;
      batchCount += 1;
      result.scanned += records.length;
      result.oldestHotTimestamp = result.oldestHotTimestamp
        ? new Date(Math.min(result.oldestHotTimestamp.getTime(), records[0].timestamp.getTime()))
        : records[0].timestamp;
      const batchResult = await archiveBatch(records, now, options.store);
      result.archived += batchResult.archived;
      result.skipped += batchResult.skipped;
      result.failed += batchResult.failed;
      activePolicy.hasMore = records.length === batchSize;
    }

    if (result.hasMore || !processedBatch) break;
  }

  if (!result.hasMore && activePolicies.some(item => item.hasMore)) {
    result.hasMore = true;
  }

  if (!result.hasMore) {
    result.oldestHotTimestamp = null;
  }
  result.backlogAgeMs = result.oldestHotTimestamp
    ? Math.max(0, now.getTime() - result.oldestHotTimestamp.getTime())
    : null;
  return result;
}

/** Verify checksum ngay trước khi xoá regular event đã archive đủ một năm. */
export async function purgeArchivedRegularEvents(
  options: PurgeArchivedRegularEventsOptions
): Promise<PurgeArchivedRegularEventsResult> {
  const now = options.now ?? new Date();
  const cutoff = getCalendarYearCutoff(now);
  const batchSize = normalizeBoundedInteger(options.batchSize, DEFAULT_ARCHIVE_BATCH_SIZE, 5_000);
  const maxBatches = normalizeBoundedInteger(options.maxBatches, DEFAULT_ARCHIVE_MAX_BATCHES, 1_000);
  const timeBudgetMs = normalizeBoundedInteger(options.timeBudgetMs, DEFAULT_ARCHIVE_TIME_BUDGET_MS, 300_000);
  const result: PurgeArchivedRegularEventsResult = { cutoff, scanned: 0, deleted: 0, failed: 0, hasMore: false };
  const startedAt = Date.now();

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    if (batchIndex > 0 && Date.now() - startedAt >= timeBudgetMs) {
      result.hasMore = true;
      break;
    }
    const records = await findArchivedRegularEventsOlderThan(cutoff, batchSize);
    if (records.length === 0) break;
    result.scanned += records.length;

    // Defense-in-depth: immutable event tuyệt đối không được đi qua nhánh purge dù query model đã lọc.
    const purgeableRecords = records.filter(record => !isImmutableProjectEventType(record.eventType));
    const verifiedEventIds: string[] = [];
    for (let offset = 0; offset < purgeableRecords.length; offset += PURGE_VERIFY_CONCURRENCY) {
      const verificationResults = await Promise.all(purgeableRecords
        .slice(offset, offset + PURGE_VERIFY_CONCURRENCY)
        .map(async record => {
          if (!record.archiveLocator || !record.archiveChecksum) {
            return { eventId: record.eventId, verified: false };
          }
          try {
            const verified = await options.store.verify(record.archiveLocator, record.archiveChecksum);
            if (!verified) {
              logger.error('Không xoá project event vì checksum cold storage không khớp.', {
                context: { eventId: record.eventId, eventType: record.eventType }
              });
            }
            return { eventId: record.eventId, verified };
          } catch (error) {
            logger.error('Purge project event thất bại; record sẽ được giữ lại.', {
              context: { eventId: record.eventId, eventType: record.eventType, errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
            });
            return { eventId: record.eventId, verified: false };
          }
        }));
      verifiedEventIds.push(...verificationResults
        .filter(resultItem => resultItem.verified)
        .map(resultItem => resultItem.eventId));
      result.failed += verificationResults.filter(resultItem => !resultItem.verified).length;
    }

    if (verifiedEventIds.length > 0) {
      try {
        result.deleted += await deleteArchivedEventsOlderThan(cutoff, verifiedEventIds);
      } catch (error) {
        result.failed += verifiedEventIds.length;
        logger.error('Purge batch project event thất bại; record sẽ được giữ lại.', {
          context: { recordCount: verifiedEventIds.length, errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
        });
      }
    }

    if (records.length < batchSize) break;
    result.hasMore = true;
  }
  return result;
}

/** Tạo cold-storage adapter dùng chung với E8 nhưng chỉ khi G4 archive được bật. */
export function createConfiguredEventArchiveStore(): AuditArchiveStore | null {
  if (process.env.EVENT_ARCHIVE_ENABLED !== 'true') return null;
  return createConfiguredAuditArchiveStore();
}
