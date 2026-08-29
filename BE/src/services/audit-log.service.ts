import { randomUUID } from 'crypto';
import { ApplicationError } from '../utils/applicationError';
import {
  AdminAuditLogModel,
  createAdminAuditLog,
  type AdminAuditAction,
  type AdminAuditActorType,
  type AdminAuditLogRecord,
  type AdminAuditTargetType,
  type CanonicalAdminAuditLogRecord
} from '../models/adminAuditLogModel';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import type { ClientSession } from 'mongoose';
import type { AuditLogListQuery } from '../validators/audit-log.validator';

const SENSITIVE_APPROVAL_THRESHOLD_VND = 10_000_000;
const SENSITIVE_CONTEXT_KEYS = new Set([
  'accountnumber', 'bankaccountnumber', 'password', 'secret', 'token',
  'accesstoken', 'refreshtoken', 'privatekey', 'rawbody', 'email', 'phone',
  'walletaddress', 'beneficiaryaddress', 'signature', 'authorization', 'cookie'
]);
// Giữ danh sách action tại service để các mock model tối giản trong test không làm vỡ module import.
const CANONICAL_AUDIT_ACTIONS: readonly AdminAuditAction[] = [
  'MANUAL_APPROVE', 'MANUAL_REJECT', 'MANUAL_BANK_ACCOUNT_VIEW',
  'OVERRIDE_VOTE_APPROVE', 'OVERRIDE_VOTE_REJECT', 'OVERRIDE_EXPIRED',
  'FEEDBACK_FLAG', 'FEEDBACK_UNFLAG', 'FEEDBACK_DELETE', 'FEEDBACK_RESTORE', 'SBT_MINT_RERUN_REQUESTED',
  'SBT_MINT_RERUN_ENQUEUED', 'SBT_MINT_RERUN_DISPATCH_FAILED', 'AUDITOR_PAYOUT_BURN_RETRY_REQUESTED', 'AUDITOR_REWARD_PAYOUT_CANCEL_REQUESTED',
  'COMMITTEE_SEAT_CREATED', 'COMMITTEE_SEAT_SUSPENDED', 'COMMITTEE_SEATS_BOOTSTRAPPED',
  'DISBURSEMENT_COMMITTEE_VOTE_APPROVE', 'DISBURSEMENT_COMMITTEE_VOTE_REJECT', 'DISBURSEMENT_COMMITTEE_EXECUTION_RECOVERED',
  'DISBURSEMENT_COMMITTEE_ON_CHAIN_DECISION_RECOVERED', 'ARBITRATION_ON_CHAIN_DECISION_RECOVERED'
] as const;
const AUDIT_READ_PROJECTION = [
  'actionId', 'actorType', 'adminId', 'adminRole', 'actionType', 'targetId', 'targetType',
  'reason', 'ipAddress', 'userAgent', 'requiresEscalation', 'escalationPolicy', 'context', 'createdAt',
  'auditId', 'adminUserId', 'action', 'targetRequestId', 'metadata'
].join(' ');

const ACTION_TARGET_TYPES: Record<AdminAuditAction, AdminAuditTargetType> = {
  MANUAL_APPROVE: 'DISBURSEMENT_REQUEST',
  MANUAL_REJECT: 'DISBURSEMENT_REQUEST',
  MANUAL_BANK_ACCOUNT_VIEW: 'DISBURSEMENT_REQUEST',
  OVERRIDE_VOTE_APPROVE: 'OVERRIDE_REQUEST',
  OVERRIDE_VOTE_REJECT: 'OVERRIDE_REQUEST',
  OVERRIDE_EXPIRED: 'OVERRIDE_REQUEST',
  FEEDBACK_FLAG: 'BENEFICIARY_FEEDBACK',
  FEEDBACK_UNFLAG: 'BENEFICIARY_FEEDBACK',
  FEEDBACK_DELETE: 'BENEFICIARY_FEEDBACK',
  FEEDBACK_RESTORE: 'BENEFICIARY_FEEDBACK',
  SBT_MINT_RERUN_REQUESTED: 'SBT_MINT_REQUEST',
  SBT_MINT_RERUN_ENQUEUED: 'SBT_MINT_REQUEST',
  SBT_MINT_RERUN_DISPATCH_FAILED: 'SBT_MINT_REQUEST',
  AUDITOR_PAYOUT_BURN_RETRY_REQUESTED: 'AUDITOR_PAYOUT',
  AUDITOR_REWARD_PAYOUT_CANCEL_REQUESTED: 'AUDITOR_PAYOUT',
  COMMITTEE_SEAT_CREATED: 'COMMITTEE_SEAT',
  COMMITTEE_SEAT_SUSPENDED: 'COMMITTEE_SEAT',
  COMMITTEE_SEATS_BOOTSTRAPPED: 'COMMITTEE_SEAT',
  DISBURSEMENT_COMMITTEE_VOTE_APPROVE: 'DISBURSEMENT_REQUEST',
  DISBURSEMENT_COMMITTEE_VOTE_REJECT: 'DISBURSEMENT_REQUEST',
  DISBURSEMENT_COMMITTEE_EXECUTION_RECOVERED: 'DISBURSEMENT_REQUEST',
  DISBURSEMENT_COMMITTEE_ON_CHAIN_DECISION_RECOVERED: 'DISBURSEMENT_REQUEST',
  ARBITRATION_ON_CHAIN_DECISION_RECOVERED: 'PROJECT_ARBITRATION'
};

const ACTION_CONTEXT_KEYS: Record<AdminAuditAction, readonly string[]> = {
  MANUAL_APPROVE: ['requestId', 'queueId', 'reviewCycle', 'amountVnd', 'projectId', 'organizationId', 'providerStatus', 'previousAttemptCount', 'previousError'],
  MANUAL_REJECT: ['requestId', 'queueId', 'reviewCycle', 'amountVnd', 'projectId', 'organizationId', 'providerStatus', 'previousAttemptCount', 'previousError'],
  MANUAL_BANK_ACCOUNT_VIEW: ['requestId', 'queueId', 'reviewCycle', 'accessMode'],
  OVERRIDE_VOTE_APPROVE: ['overrideRequestId', 'projectId', 'organizationId', 'disbursementRequestId', 'commissionerSnapshotSize', 'vote', 'voteCountAfter', 'outcome'],
  OVERRIDE_VOTE_REJECT: ['overrideRequestId', 'projectId', 'organizationId', 'disbursementRequestId', 'commissionerSnapshotSize', 'vote', 'voteCountAfter', 'outcome'],
  OVERRIDE_EXPIRED: ['overrideRequestId', 'projectId', 'organizationId', 'commissionerSnapshotSize', 'outcome'],
  FEEDBACK_FLAG: ['feedbackId', 'projectId', 'isFlaggedBefore', 'isFlaggedAfter', 'riskScore', 'reason'],
  FEEDBACK_UNFLAG: ['feedbackId', 'projectId', 'isFlaggedBefore', 'isFlaggedAfter', 'riskScore', 'reason'],
  FEEDBACK_DELETE: ['feedbackId', 'projectId', 'rating', 'riskScore', 'isFlaggedBefore', 'source', 'submittedAt', 'purgeAfter', 'reason'],
  FEEDBACK_RESTORE: ['feedbackId', 'projectId', 'riskScore', 'deletedAt', 'deletedByAdminId', 'daysBeforePurge', 'reason'],
  SBT_MINT_RERUN_REQUESTED: ['mintRequestId', 'sbtId', 'previousStatus', 'previousAttemptNumber', 'reRunCount', 'jobId', 'enqueueResult', 'outboxEventId', 'dispatchAttempt'],
  SBT_MINT_RERUN_ENQUEUED: ['mintRequestId', 'sbtId', 'previousStatus', 'previousAttemptNumber', 'reRunCount', 'jobId', 'enqueueResult', 'outboxEventId', 'dispatchAttempt'],
  SBT_MINT_RERUN_DISPATCH_FAILED: ['mintRequestId', 'sbtId', 'previousStatus', 'previousAttemptNumber', 'reRunCount', 'jobId', 'enqueueResult', 'outboxEventId', 'dispatchAttempt'],
  AUDITOR_PAYOUT_BURN_RETRY_REQUESTED: ['payoutId'],
  AUDITOR_REWARD_PAYOUT_CANCEL_REQUESTED: ['payoutId'],
  COMMITTEE_SEAT_CREATED: ['role', 'displayName'],
  COMMITTEE_SEAT_SUSPENDED: ['role', 'displayName'],
  COMMITTEE_SEATS_BOOTSTRAPPED: ['transactionHash', 'chainId', 'seatCount'],
  DISBURSEMENT_COMMITTEE_VOTE_APPROVE: ['requestId', 'vote', 'outcome', 'gpsRiskAcknowledged'],
  DISBURSEMENT_COMMITTEE_VOTE_REJECT: ['requestId', 'vote', 'outcome', 'gpsRiskAcknowledged'],
  DISBURSEMENT_COMMITTEE_EXECUTION_RECOVERED: ['requestId', 'executionStatus'],
  DISBURSEMENT_COMMITTEE_ON_CHAIN_DECISION_RECOVERED: ['requestId', 'onChainDecisionStatus', 'scope'],
  ARBITRATION_ON_CHAIN_DECISION_RECOVERED: ['arbitrationId', 'onChainDecisionStatus']
};

export type RecordAdminAuditLogInput = {
  actionId?: string;
  actorType: AdminAuditActorType;
  adminId: string | null;
  adminRole: string | null;
  actionType: AdminAuditAction;
  targetId: string;
  targetType: AdminAuditTargetType;
  reason?: string | null;
  requestContext?: AuditRequestContext;
  ipAddress?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown>;
  requiresEscalation?: boolean;
  escalationPolicy?: string | null;
  createdAt?: Date;
  session?: ClientSession;
};

export type AuditLogReadItem = {
  actionId: string;
  actionType: AdminAuditAction;
  adminId: string | null;
  adminRole: string | null;
  targetId: string;
  targetType: AdminAuditTargetType;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requiresEscalation: boolean;
  context: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogListFilters = AuditLogListQuery;

export type AuditLogListResult = {
  items: AuditLogReadItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/**
 * Lọc context theo allowlist của action và giới hạn dữ liệu trước khi lưu/đọc.
 * Cách này ngăn raw request body, bank account và token đi vào audit page.
 */
export function sanitizeAuditContext(
  actionType: AdminAuditAction,
  context: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!context) return {};
  const allowedKeys = new Set(ACTION_CONTEXT_KEYS[actionType]);
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    if (!allowedKeys.has(key)) continue;
    sanitized[key] = sanitizeContextValue(value);
  }

  return sanitized;
}

/** Chuyển value động về dữ liệu bounded và không giữ object lồng quá sâu. */
function sanitizeContextValue(value: unknown, depth: number = 0): unknown {
  if (depth > 2) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeContextValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_CONTEXT_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')))
        .slice(0, 20)
        .map(([key, nestedValue]) => [key, sanitizeContextValue(nestedValue, depth + 1)])
    );
  }
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

/**
 * Ghi action audit canonical với actionId unique và adapter legacy read-compatible.
 * Duplicate actionId được coi là replay thành công, không tạo thêm record.
 */
export async function recordAdminAuditLog(
  input: RecordAdminAuditLogInput
): Promise<CanonicalAdminAuditLogRecord> {
  validateAuditInput(input);
  const actionId = input.actionId?.trim() || randomUUID();
  const context = sanitizeAuditContext(input.actionType, input.context);
  const amountVnd = typeof context.amountVnd === 'number' ? context.amountVnd : null;
  const requiresEscalation = input.actionType === 'MANUAL_APPROVE'
    && amountVnd !== null
    && amountVnd > SENSITIVE_APPROVAL_THRESHOLD_VND;
  const canonicalRecord: CanonicalAdminAuditLogRecord = {
    actionId,
    actorType: input.actorType,
    adminId: input.actorType === 'ADMIN' ? normalizeNullableString(input.adminId, 200) : null,
    adminRole: input.actorType === 'ADMIN' ? normalizeNullableString(input.adminRole, 100) : null,
    actionType: input.actionType,
    targetId: input.targetId.trim(),
    targetType: input.targetType,
    reason: input.reason === null || input.reason === undefined
      ? null
      : input.reason.trim().slice(0, 1_000),
    ipAddress: input.actorType === 'ADMIN'
      ? normalizeNullableString(input.ipAddress ?? input.requestContext?.ipAddress, 128)
      : null,
    userAgent: input.actorType === 'ADMIN'
      ? normalizeNullableString(input.userAgent ?? input.requestContext?.userAgent, 512)
      : null,
    context,
    requiresEscalation,
    escalationPolicy: requiresEscalation ? 'MANUAL_APPROVAL_GT_10M_VND' : null,
    archiveState: 'HOT',
    archivedAt: null,
    archiveLocator: null,
    archiveChecksum: null,
    createdAt: input.createdAt ?? new Date()
  };

  const auditDocument = {
      ...canonicalRecord,
      // Các alias này chỉ để manual-review detail và migration đọc được record mới.
      auditId: actionId,
      adminUserId: canonicalRecord.adminId ?? 'system',
      action: canonicalRecord.actionType,
      targetRequestId: canonicalRecord.targetId,
      metadata: canonicalRecord.context
    };

  try {
    if (input.session) {
      await createAdminAuditLog(auditDocument, input.session);
    } else {
      await createAdminAuditLog(auditDocument);
    }
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await findCanonicalAuditLogByActionId(actionId, input.session);
    if (!existing) throw error;
  }

  return canonicalRecord;
}

/** Validate action, actor và target trước khi ghi audit. */
function validateAuditInput(input: RecordAdminAuditLogInput): void {
  if (!['ADMIN', 'SYSTEM'].includes(input.actorType)) {
    throw new ApplicationError('actorType audit không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
  if (!CANONICAL_AUDIT_ACTIONS.includes(input.actionType)) {
    throw new ApplicationError('actionType audit không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
  if (ACTION_TARGET_TYPES[input.actionType] !== input.targetType) {
    throw new ApplicationError('targetType không khớp với actionType audit.', 400, 'VALIDATION_ERROR');
  }
  if (!input.targetId.trim()) {
    throw new ApplicationError('targetId audit không được để trống.', 400, 'VALIDATION_ERROR');
  }
  if (input.targetId.trim().length > 200) {
    throw new ApplicationError('targetId audit vượt quá giới hạn.', 400, 'VALIDATION_ERROR');
  }
  if (input.actorType === 'ADMIN' && (!input.adminId?.trim() || !input.adminRole?.trim())) {
    throw new ApplicationError('Audit admin phải có adminId và adminRole.', 400, 'VALIDATION_ERROR');
  }
  if (input.actorType === 'SYSTEM' && (input.adminId !== null || input.adminRole !== null)) {
    throw new ApplicationError('Audit system không được giả actor admin.', 400, 'VALIDATION_ERROR');
  }
}

/** Chuẩn hóa chuỗi định danh/request metadata để audit không phình vô hạn. */
function normalizeNullableString(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

/** Xác định lỗi duplicate key của Mongo mà không phụ thuộc driver cụ thể. */
function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

/** Đọc lại record canonical sau replay actionId để trả DTO thống nhất. */
async function findCanonicalAuditLogByActionId(
  actionId: string,
  session?: ClientSession
): Promise<AdminAuditLogRecord | null> {
  const query = AdminAuditLogModel.findOne({ actionId });
  if (session) query.session(session);
  const record = await query.lean<AdminAuditLogRecord>().exec();
  return record;
}

/**
 * Query canonical audit server-side với predicate và count giống nhau.
 * Legacy admin record được normalize tại boundary; webhook/system record bị loại khỏi danh sách admin.
 */
export async function listAdminAuditLogs(filters: AuditLogListFilters): Promise<AuditLogListResult> {
  const query = buildAuditLogQuery(filters);
  const [records, total] = await Promise.all([
    AdminAuditLogModel.find(query)
      .select(AUDIT_READ_PROJECTION)
      .sort({ createdAt: -1, actionId: -1 })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .lean<AdminAuditLogRecord[]>()
      .exec(),
    AdminAuditLogModel.countDocuments(query).exec()
  ]);

  const items = records
    .map(normalizeAuditRecord)
    .filter((item): item is AuditLogReadItem => item !== null);
  return {
    items,
    page: filters.page,
    limit: filters.limit,
    total,
    totalPages: Math.ceil(total / filters.limit)
  };
}

/** Tạo Mongo predicate canonical + legacy normalized, không gom webhook audit khác schema. */
export function buildAuditLogQuery(filters: AuditLogListFilters): Record<string, unknown> {
  const queryParts: Record<string, unknown>[] = [{
    $or: [
      {
        actorType: 'ADMIN',
        actionType: { $in: CANONICAL_AUDIT_ACTIONS },
        actionId: { $exists: true, $nin: [null, ''] },
        targetId: { $exists: true, $nin: [null, ''] },
        targetType: { $exists: true, $nin: [null, ''] }
      },
      {
        actorType: { $exists: false },
        action: { $in: CANONICAL_AUDIT_ACTIONS },
        adminUserId: { $nin: ['system', null, ''] },
        auditId: { $exists: true, $nin: [null, ''] },
        targetRequestId: { $exists: true, $nin: [null, ''] }
      }
    ]
  }];
  if (filters.actionType) {
    queryParts.push({ $or: [{ actionType: filters.actionType }, { action: filters.actionType }] });
  }
  if (filters.adminId) {
    queryParts.push({ $or: [{ adminId: filters.adminId }, { adminUserId: filters.adminId }] });
  }
  const dateRange = buildDateRange(filters.from, filters.to);
  if (dateRange) queryParts.push({ createdAt: dateRange });
  return { $and: queryParts };
}

/** Chuyển from/to thành range UTC, date-only được hiểu theo ngày Việt Nam. */
function buildDateRange(from?: string, to?: string): { $gte?: Date; $lt?: Date } | null {
  const range: { $gte?: Date; $lt?: Date } = {};
  if (from) range.$gte = parseDateBoundary(from, false);
  if (to) range.$lt = parseDateBoundary(to, true);
  return Object.keys(range).length > 0 ? range : null;
}

/** Parse ISO instant hoặc ngày local Asia/Ho_Chi_Minh thành UTC Date. */
function parseDateBoundary(value: string, isEnd: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000+07:00`);
    if (isEnd) parsed.setTime(parsed.getTime() + 24 * 60 * 60 * 1000);
    return parsed;
  }
  return new Date(value);
}

/** Normalize canonical hoặc legacy document thành read DTO allowlisted. */
function normalizeAuditRecord(record: AdminAuditLogRecord): AuditLogReadItem | null {
  const actionType = record.actionType ?? record.action;
  if (!actionType || !CANONICAL_AUDIT_ACTIONS.includes(actionType)) return null;
  const actionId = record.actionId ?? record.auditId;
  const targetId = normalizeNullableString(record.targetId ?? record.targetRequestId, 200);
  if (!actionId) return null;
  if (!targetId) return null;
  const targetType = isAdminAuditTargetType(record.targetType)
    ? record.targetType
    : inferTargetType(actionType);
  const context = sanitizeAuditContext(actionType, record.context ?? record.metadata);
  return {
    actionId,
    actionType,
    adminId: normalizeNullableString(record.adminId ?? record.adminUserId, 200),
    adminRole: normalizeNullableString(record.adminRole, 100),
    targetId,
    targetType,
    reason: normalizeNullableString(record.reason, 1_000),
    ipAddress: normalizeNullableString(record.ipAddress, 128),
    userAgent: normalizeNullableString(record.userAgent, 512),
    requiresEscalation: record.requiresEscalation ?? (
      actionType === 'MANUAL_APPROVE'
      && typeof context.amountVnd === 'number'
      && context.amountVnd > SENSITIVE_APPROVAL_THRESHOLD_VND
    ),
    context,
    createdAt: new Date(record.createdAt).toISOString()
  };
}

/** Suy luận target type cho legacy record mà không bịa target ID. */
function inferTargetType(actionType: AdminAuditAction): AdminAuditTargetType {
  return ACTION_TARGET_TYPES[actionType];
}

/** Kiểm tra target type legacy trước khi đưa dữ liệu vào read DTO. */
function isAdminAuditTargetType(value: unknown): value is AdminAuditTargetType {
  return value === 'DISBURSEMENT_REQUEST'
    || value === 'OVERRIDE_REQUEST'
    || value === 'BENEFICIARY_FEEDBACK'
    || value === 'SBT_MINT_REQUEST'
    || value === 'AUDITOR_PAYOUT'
    || value === 'COMMITTEE_SEAT'
    || value === 'PROJECT_ARBITRATION';
}
