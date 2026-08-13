import { createHash } from 'crypto';
import { getLogger } from '../config/logger';
import { AdminAuditLogModel, type AdminAuditLogRecord } from '../models/adminAuditLogModel';
import { sanitizeAuditContext } from './audit-log.service';

export interface AuditArchiveStore {
  putImmutable(locator: string, payload: Buffer, checksum: string): Promise<void>;
  verify(locator: string, checksum: string): Promise<boolean>;
}

export interface ArchiveAdminAuditLogsOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  store: AuditArchiveStore;
}

export interface ArchiveAdminAuditLogsResult {
  cutoff: Date;
  scanned: number;
  archived: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
  oldestHotCreatedAt: Date | null;
  backlogAgeMs: number | null;
}

const DEFAULT_ARCHIVE_BATCH_SIZE = 500;
const DEFAULT_ARCHIVE_MAX_BATCHES = 100;
const DEFAULT_ARCHIVE_TIME_BUDGET_MS = 30_000;
const ARCHIVE_CONCURRENCY = 8;
const ARCHIVE_PREFIX = 'admin-audit-logs';
const ARCHIVE_READ_PROJECTION = [
  'actionId', 'auditId', 'actorType', 'adminId', 'adminUserId', 'adminRole',
  'actionType', 'action', 'targetId', 'targetRequestId', 'targetType', 'reason',
  'ipAddress', 'userAgent', 'context', 'metadata', 'requiresEscalation',
  'escalationPolicy', 'createdAt'
].join(' ');
const logger = getLogger();

/** Archive record HOT cũ hơn một calendar year, upload immutable rồi mới đánh dấu ARCHIVED. */
export async function archiveAdminAuditLogs(
  options: ArchiveAdminAuditLogsOptions
): Promise<ArchiveAdminAuditLogsResult> {
  const now = options.now ?? new Date();
  const cutoff = getCalendarYearCutoff(now);
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_ARCHIVE_BATCH_SIZE, 1), 5_000);
  const maxBatches = Math.min(Math.max(options.maxBatches ?? DEFAULT_ARCHIVE_MAX_BATCHES, 1), 1_000);
  const timeBudgetMs = Math.min(Math.max(options.timeBudgetMs ?? DEFAULT_ARCHIVE_TIME_BUDGET_MS, 1), 300_000);
  const result: ArchiveAdminAuditLogsResult = {
    cutoff,
    scanned: 0,
    archived: 0,
    skipped: 0,
    failed: 0,
    hasMore: false,
    oldestHotCreatedAt: null,
    backlogAgeMs: null
  };

  const startedAt = Date.now();
  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    if (batchIndex > 0 && Date.now() - startedAt >= timeBudgetMs) {
      result.hasMore = true;
      break;
    }

    const records = await AdminAuditLogModel.find({
      archiveState: 'HOT',
      createdAt: { $lt: cutoff }
    })
      .sort({ createdAt: 1, actionId: 1 })
      .select(ARCHIVE_READ_PROJECTION)
      .limit(batchSize)
      .lean<AdminAuditLogRecord[]>()
      .exec();

    if (records.length === 0) {
      result.hasMore = false;
      break;
    }
    result.scanned += records.length;
    result.oldestHotCreatedAt = records[0].createdAt ?? result.oldestHotCreatedAt;

    for (let offset = 0; offset < records.length; offset += ARCHIVE_CONCURRENCY) {
      const chunk = records.slice(offset, offset + ARCHIVE_CONCURRENCY);
      const outcomes = await Promise.all(chunk.map(record => archiveOneAuditRecord(record, now, options.store)));
      result.archived += outcomes.filter(outcome => outcome === 'archived').length;
      result.skipped += outcomes.filter(outcome => outcome === 'skipped').length;
      result.failed += outcomes.filter(outcome => outcome === 'failed').length;
    }

    result.hasMore = records.length >= batchSize;
    if (records.length < batchSize) break;
  }

  if (!result.hasMore) result.oldestHotCreatedAt = null;
  result.backlogAgeMs = result.oldestHotCreatedAt
    ? Math.max(0, now.getTime() - result.oldestHotCreatedAt.getTime())
    : null;
  return result;
}

/** Upload và chuyển state một record; giữ HOT khi archive thất bại để chu kỳ sau retry. */
async function archiveOneAuditRecord(
  record: AdminAuditLogRecord,
  archivedAt: Date,
  store: AuditArchiveStore
): Promise<'archived' | 'skipped' | 'failed'> {
  const actionId = record.actionId ?? record.auditId;
  if (!actionId || !record.createdAt) return 'skipped';
  let locator: string | null = null;

  try {
    const payload = serializeAuditArchiveRecord(record);
    const checksum = sha256(payload);
    locator = buildArchiveLocator(actionId, record.createdAt);

    await store.putImmutable(locator, payload, checksum);
    if (!await store.verify(locator, checksum)) {
      throw new Error('Archive checksum verification failed.');
    }

    const updateResult = await AdminAuditLogModel.updateOne(
      { actionId, archiveState: 'HOT' },
      {
        $set: {
          archiveState: 'ARCHIVED',
          archivedAt,
          archiveLocator: locator,
          archiveChecksum: checksum
        }
      }
    ).exec();

    // Worker khác có thể đã chuyển state sau upload; không ghi đè lại state.
    return updateResult.modifiedCount === 1 || updateResult.matchedCount === 1 ? 'archived' : 'skipped';
  } catch (error) {
    logger.error('Archive audit record thất bại; record sẽ được retry ở chu kỳ sau.', {
      actionId,
      archiveLocator: locator,
      errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      errorMessage: error instanceof Error ? error.message : 'Unknown archive error'
    });
    return 'failed';
  }
}

/** Calendar year cutoff: 2026-08-12 -> 2025-08-12, không dùng 365*24h. */
export function getCalendarYearCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return cutoff;
}

/** Serialize đúng canonical allowlisted fields, không dump raw Mongo document. */
export function serializeAuditArchiveRecord(record: AdminAuditLogRecord): Buffer {
  const actionType = record.actionType ?? record.action;
  if (!actionType) throw new Error('Audit record thiếu actionType.');

  const safeRecord = {
    actionId: record.actionId ?? record.auditId,
    actorType: record.actorType ?? 'ADMIN',
    adminId: boundNullableString(record.adminId ?? record.adminUserId, 200),
    adminRole: boundNullableString(record.adminRole, 100),
    actionType,
    targetId: boundNullableString(record.targetId ?? record.targetRequestId, 200),
    targetType: record.targetType ?? null,
    reason: boundNullableString(record.reason, 1_000),
    ipAddress: boundNullableString(record.ipAddress, 128),
    userAgent: boundNullableString(record.userAgent, 512),
    context: sanitizeAuditContext(actionType, record.context ?? record.metadata),
    requiresEscalation: record.requiresEscalation ?? false,
    escalationPolicy: record.escalationPolicy ?? null,
    createdAt: new Date(record.createdAt).toISOString()
  };

  return Buffer.from(`${JSON.stringify(safeRecord)}\n`, 'utf8');
}

export function sha256(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function buildArchiveLocator(actionId: string, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `${ARCHIVE_PREFIX}/${year}/${month}/${encodeURIComponent(actionId)}.json`;
}

/** Giới hạn field legacy trước khi đóng gói archive để tránh payload phình bất thường. */
function boundNullableString(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

/** Adapter HTTP cho private S3-compatible gateway/bucket đã cấu hình sẵn. */
export class S3CompatibleAuditArchiveStore implements AuditArchiveStore {
  private readonly endpoint: string;
  private readonly bearerToken: string;

  constructor(endpoint: string, bearerToken: string | undefined, allowedHosts: readonly string[]) {
    const normalizedEndpoint = endpoint.trim();
    const normalizedToken = bearerToken?.trim();
    const normalizedAllowedHosts = new Set(allowedHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
    if (!normalizedEndpoint || !normalizedToken) {
      throw new Error('Audit archive endpoint và bearer credential là bắt buộc.');
    }
    if (normalizedAllowedHosts.size === 0) {
      throw new Error('Audit archive allowed host là bắt buộc.');
    }
    const parsedEndpoint = new URL(normalizedEndpoint);
    if (parsedEndpoint.protocol !== 'https:') {
      throw new Error('Audit archive endpoint phải dùng HTTPS.');
    }
    if (!normalizedAllowedHosts.has(parsedEndpoint.hostname.toLowerCase())) {
      throw new Error('Audit archive endpoint không nằm trong host allowlist.');
    }
    this.endpoint = normalizedEndpoint.endsWith('/') ? normalizedEndpoint : `${normalizedEndpoint}/`;
    this.bearerToken = normalizedToken;
  }

  async putImmutable(locator: string, payload: Buffer, checksum: string): Promise<void> {
    const url = this.getObjectUrl(locator);
    const existing = await this.head(url);
    if (existing.exists) {
      if (existing.checksum !== checksum) throw new Error('Immutable archive locator checksum mismatch.');
      return;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'application/json',
        'cache-control': 'immutable',
        'x-amz-checksum-sha256': checksum,
        'x-amz-server-side-encryption': 'AES256',
        'if-none-match': '*'
      }),
      body: payload.toString('utf8')
    });
    if (!response.ok && response.status !== 409 && response.status !== 412) {
      throw new Error(`Archive object upload failed with status ${response.status}.`);
    }
    // Service sẽ HEAD + đối chiếu checksum sau khi adapter hoàn tất PUT.
  }

  async verify(locator: string, checksum: string): Promise<boolean> {
    const result = await this.head(this.getObjectUrl(locator));
    return result.exists && result.checksum === checksum;
  }

  private async head(url: string): Promise<{ exists: boolean; checksum: string | null }> {
    const response = await fetch(url, { method: 'HEAD', headers: this.headers() });
    if (response.status === 404) return { exists: false, checksum: null };
    if (!response.ok) throw new Error(`Archive object HEAD failed with status ${response.status}.`);
    return {
      exists: true,
      checksum: response.headers.get('x-amz-checksum-sha256') ?? response.headers.get('x-checksum-sha256')
    };
  }

  private getObjectUrl(locator: string): string {
    return new URL(locator, this.endpoint).toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      ...extra
    };
  }
}

export function createConfiguredAuditArchiveStore(): AuditArchiveStore | null {
  const endpoint = process.env.AUDIT_ARCHIVE_S3_ENDPOINT?.trim();
  if (!endpoint) return null;
  const bearerToken = process.env.AUDIT_ARCHIVE_S3_BEARER_TOKEN?.trim();
  if (!bearerToken) return null;
  const allowedHosts = (process.env.AUDIT_ARCHIVE_S3_ALLOWED_HOSTS ?? '').split(',');
  try {
    return new S3CompatibleAuditArchiveStore(endpoint, bearerToken, allowedHosts);
  } catch (error) {
    logger.error('Audit archive config không hợp lệ; worker fail-closed.', {
      errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    return null;
  }
}
