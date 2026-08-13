import crypto from 'crypto';
import {
  ADMIN_AUDIT_ACTIONS,
  type AdminAuditAction,
  type AdminAuditTargetType
} from '../models/adminAuditLogModel';
import { sanitizeAuditContext } from '../services/audit-log.service';

type MigrationDocument = Record<string, unknown>;
type MigrationProjection = Record<string, 0 | 1>;
type MigrationCursor = {
  batchSize?: (size: number) => MigrationCursor;
  sort?: (spec: Record<string, 1 | -1>) => MigrationCursor;
  hasNext?: () => Promise<boolean>;
  next?: () => Promise<MigrationDocument>;
  toArray?: () => Promise<MigrationDocument[]>;
};
type MigrationCollection = {
  find(filter: Record<string, unknown>, options?: { projection?: MigrationProjection }): MigrationCursor;
  insertOne(document: MigrationDocument): Promise<unknown>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
};

export type AdminAuditMigrationOptions = {
  dryRun?: boolean;
  sourceCollection: MigrationCollection;
  webhookCollection: MigrationCollection;
};

export type AdminAuditMigrationReport = {
  scanned: number;
  webhookCandidates: number;
  webhookCopied: number;
  canonicalBackfilled: number;
  unresolved: number;
  sourceChecksum: string;
};

const LEGACY_AUDIT_PROJECTION: MigrationProjection = {
  _id: 1,
  actionId: 1,
  auditId: 1,
  adminUserId: 1,
  action: 1,
  targetRequestId: 1,
  reason: 1,
  metadata: 1,
  createdAt: 1,
  sourceIp: 1,
  requestBody: 1,
  signature: 1,
  orderCode: 1,
  errorMessage: 1,
  timestamp: 1
};

/**
 * Migrate legacy audit document theo hướng copy/backfill idempotent.
 * Source document luôn được giữ nguyên để rollback chỉ cần bỏ pointer/backfill.
 */
export async function migrateAdminAuditLogSchema(
  options: AdminAuditMigrationOptions
): Promise<AdminAuditMigrationReport> {
  const cursor = options.sourceCollection.find({}, { projection: LEGACY_AUDIT_PROJECTION });
  cursor.sort?.({ _id: 1 });
  cursor.batchSize?.(500);
  const checksum = crypto.createHash('sha256');
  const report: AdminAuditMigrationReport = {
    scanned: 0,
    webhookCandidates: 0,
    webhookCopied: 0,
    canonicalBackfilled: 0,
    unresolved: 0,
    sourceChecksum: ''
  };

  const processDocument = async (document: MigrationDocument): Promise<void> => {
    report.scanned += 1;
    checksum.update(JSON.stringify(normalizeChecksumDocument(document)));
    const action = typeof document.action === 'string' ? document.action : null;
    if (action?.startsWith('WEBHOOK_')) {
      report.webhookCandidates += 1;
      if (!options.dryRun && await copyWebhookDocument(document, options.webhookCollection)) {
        report.webhookCopied += 1;
      }
      return;
    }

    if (document.actionId || !isCanonicalAction(action)) return;
    const backfill = buildCanonicalBackfill(document, action);
    if (!backfill) {
      report.unresolved += 1;
      return;
    }
    if (!options.dryRun) {
      await options.sourceCollection.updateOne(
        { _id: document._id },
        { $set: backfill }
      );
    }
    report.canonicalBackfilled += 1;
  };

  if (cursor.hasNext && cursor.next) {
    while (await cursor.hasNext()) {
      await processDocument(await cursor.next());
    }
  } else if (cursor.toArray) {
    // Fallback chỉ dành cho mock/test cursor; MongoDB production luôn dùng next() theo batch.
    for (const document of await cursor.toArray()) {
      await processDocument(document);
    }
  } else {
    throw new Error('Migration cursor không hỗ trợ iterator an toàn.');
  }

  report.sourceChecksum = checksum.digest('hex');
  return report;
}

/** Copy webhook legacy document sang collection riêng, không delete source. */
async function copyWebhookDocument(
  document: MigrationDocument,
  webhookCollection: MigrationCollection
): Promise<boolean> {
  const auditId = typeof document.auditId === 'string' ? document.auditId : null;
  if (!auditId) return false;
  const existingCursor = webhookCollection.find({ auditId });
  if (existingCursor.hasNext && await existingCursor.hasNext()) return false;
  if (!existingCursor.hasNext && existingCursor.toArray && (await existingCursor.toArray()).length > 0) return false;
  const webhookDocument = buildLegacyWebhookDocument(document);
  if (!webhookDocument) return false;
  await webhookCollection.insertOne(webhookDocument);
  return true;
}

/** Chỉ copy shape webhook cần thiết, không đưa raw legacy document vào collection mới. */
function buildLegacyWebhookDocument(document: MigrationDocument): MigrationDocument | null {
  const auditId = typeof document.auditId === 'string' ? document.auditId : null;
  const action = normalizeWebhookAction(document.action);
  const timestamp = toDate(document.timestamp ?? document.createdAt);
  if (!auditId || !action || !timestamp) return null;

  return {
    auditId,
    action,
    sourceIp: typeof document.sourceIp === 'string' ? document.sourceIp.slice(0, 128) : 'legacy-unknown',
    requestBody: sanitizeLegacyWebhookBody(document.requestBody),
    signature: typeof document.signature === 'string' ? document.signature.slice(0, 512) : null,
    orderCode: typeof document.orderCode === 'string' ? document.orderCode.slice(0, 200) : null,
    errorMessage: typeof document.errorMessage === 'string' ? document.errorMessage.slice(0, 1_000) : null,
    timestamp,
    sourceCollection: 'admin_audit_logs_legacy'
  };
}

/** Chuẩn hóa action webhook cũ về enum collection mới. */
function normalizeWebhookAction(value: unknown): 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PROCESSED' | 'WEBHOOK_DUPLICATE' | null {
  if (value === 'WEBHOOK_SIGNATURE_INVALID' || value === 'WEBHOOK_PROCESSED' || value === 'WEBHOOK_DUPLICATE') {
    return value;
  }
  if (value === 'WEBHOOK_RECEIVED') return 'WEBHOOK_PROCESSED';
  return null;
}

/** Giới hạn request body legacy trước khi copy để migration không nhân bản payload không kiểm soát. */
function sanitizeLegacyWebhookBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [key.slice(0, 100), sanitizeLegacyWebhookValue(item)])
  );
}

/** Giới hạn value webhook legacy theo độ sâu và kích thước để giữ migration bounded-memory. */
function sanitizeLegacyWebhookValue(value: unknown, depth = 0): unknown {
  if (depth >= 2) return '[TRUNCATED]';
  if (typeof value === 'string') return value.slice(0, 1_000);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeLegacyWebhookValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, item]) => [key.slice(0, 100), sanitizeLegacyWebhookValue(item, depth + 1)])
    );
  }
  return value;
}

/** Chuyển timestamp legacy hợp lệ thành Date; dữ liệu hỏng sẽ được giữ unresolved. */
function toDate(value: unknown): Date | null {
  const date = value instanceof Date ? new Date(value) : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Chuẩn hoá action legacy thành canonical field mà không suy diễn dữ liệu thiếu. */
function buildCanonicalBackfill(
  document: MigrationDocument,
  action: AdminAuditAction
): Record<string, unknown> | null {
  const targetId = typeof document.targetRequestId === 'string' ? document.targetRequestId : null;
  const auditId = typeof document.auditId === 'string' ? document.auditId : null;
  if (!targetId || !auditId) return null;

  const legacyAdminId = typeof document.adminUserId === 'string' ? document.adminUserId : null;
  const isSystem = legacyAdminId === 'system';
  const targetType = inferTargetType(action);
  const metadata = document.metadata && typeof document.metadata === 'object'
    ? document.metadata as Record<string, unknown>
    : {};
  return {
    actionId: auditId,
    actorType: isSystem ? 'SYSTEM' : 'ADMIN',
    adminId: isSystem ? null : legacyAdminId,
    adminRole: isSystem ? null : 'admin',
    actionType: action,
    targetId,
    targetType,
    reason: typeof document.reason === 'string' ? document.reason : null,
    ipAddress: null,
    userAgent: null,
    context: sanitizeAuditContext(action, metadata),
    requiresEscalation: false,
    escalationPolicy: null,
    archiveState: 'HOT',
    archivedAt: null,
    archiveLocator: null,
    archiveChecksum: null
  };
}

/** Kiểm tra action có thuộc contract E8 hay không. */
function isCanonicalAction(value: string | null): value is AdminAuditAction {
  return value !== null && ADMIN_AUDIT_ACTIONS.includes(value as AdminAuditAction);
}

/** Suy luận target type theo action legacy, không động vào target ID gốc. */
function inferTargetType(action: AdminAuditAction): AdminAuditTargetType {
  if (action.startsWith('OVERRIDE_')) return 'OVERRIDE_REQUEST';
  if (action.startsWith('MANUAL_')) return 'DISBURSEMENT_REQUEST';
  if (action.startsWith('FEEDBACK_')) return 'BENEFICIARY_FEEDBACK';
  return 'SBT_MINT_REQUEST';
}

/** Chuẩn hóa dữ liệu tối thiểu để checksum không làm lộ PII trong log. */
function normalizeChecksumDocument(document: MigrationDocument): Record<string, unknown> {
  return {
    auditId: document.auditId ?? null,
    action: document.action ?? null,
    targetRequestId: document.targetRequestId ?? null,
    createdAt: document.createdAt ?? null
  };
}

/** Chạy migration thủ công với mặc định dry-run; chỉ --apply mới được phép ghi. */
async function runMigration(): Promise<void> {
  const { connectToMongoDb } = await import('../config/mongodb');
  await connectToMongoDb();
  const mongoose = (await import('mongoose')).default;
  if (!mongoose.connection.db) throw new Error('MongoDB chưa sẵn sàng cho migration.');
  const sourceCollection = mongoose.connection.db.collection('admin_audit_logs') as unknown as MigrationCollection;
  const webhookCollection = mongoose.connection.db.collection('webhook_audit_logs') as unknown as MigrationCollection;
  const report = await migrateAdminAuditLogSchema({
    dryRun: !process.argv.includes('--apply'),
    sourceCollection,
    webhookCollection
  });
  console.log(JSON.stringify(report));
  process.exitCode = 0;
}

if (require.main === module) {
  void runMigration().catch(() => {
    process.exitCode = 1;
  });
}
