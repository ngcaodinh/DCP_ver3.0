import mongoose, { Schema, type ClientSession } from 'mongoose';

/** Danh sách action canonical được phép xuất hiện trong audit trail admin E8. */
export const ADMIN_AUDIT_ACTIONS = [
  'MANUAL_APPROVE',
  'MANUAL_REJECT',
  'MANUAL_BANK_ACCOUNT_VIEW',
  'OVERRIDE_VOTE_APPROVE',
  'OVERRIDE_VOTE_REJECT',
  'OVERRIDE_EXPIRED',
  'FEEDBACK_FLAG',
  'FEEDBACK_UNFLAG',
  'SBT_MINT_RERUN_REQUESTED',
  'SBT_MINT_RERUN_ENQUEUED',
  'SBT_MINT_RERUN_DISPATCH_FAILED'
] as const;

export type AdminAuditAction = typeof ADMIN_AUDIT_ACTIONS[number];
export type AdminAuditActorType = 'ADMIN' | 'SYSTEM';
export type AdminAuditTargetType =
  | 'DISBURSEMENT_REQUEST'
  | 'OVERRIDE_REQUEST'
  | 'BENEFICIARY_FEEDBACK'
  | 'SBT_MINT_REQUEST';
export type AdminAuditArchiveState = 'HOT' | 'ARCHIVED';

/** Bản ghi canonical đầy đủ dùng bởi service ghi/đọc audit log. */
export interface CanonicalAdminAuditLogRecord {
  actionId: string;
  actorType: AdminAuditActorType;
  adminId: string | null;
  adminRole: string | null;
  actionType: AdminAuditAction;
  targetId: string;
  targetType: AdminAuditTargetType;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  context: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationPolicy: string | null;
  archiveState: AdminAuditArchiveState;
  archivedAt: Date | null;
  archiveLocator: string | null;
  archiveChecksum: string | null;
  createdAt: Date;
}

/**
 * Kiểu tương thích cho bản ghi legacy và canonical trong giai đoạn migration.
 * Các field legacy chỉ phục vụ đọc lại detail cũ, không dùng để ghi action mới.
 */
export interface AdminAuditLogRecord extends Partial<CanonicalAdminAuditLogRecord> {
  auditId: string;
  adminUserId: string;
  action: AdminAuditAction;
  targetRequestId: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const adminAuditLogSchema = new Schema<AdminAuditLogRecord>({
  // Canonical fields. Required được kiểm soát ở service để vẫn đọc được document legacy.
  actionId: { type: String, unique: true, sparse: true },
  actorType: { type: String, enum: ['ADMIN', 'SYSTEM'] },
  adminId: { type: String, index: true },
  adminRole: { type: String },
  actionType: {
    type: String,
    enum: ADMIN_AUDIT_ACTIONS,
    index: true
  },
  targetId: { type: String, index: true },
  targetType: {
    type: String,
    enum: ['DISBURSEMENT_REQUEST', 'OVERRIDE_REQUEST', 'BENEFICIARY_FEEDBACK', 'SBT_MINT_REQUEST'],
    index: true
  },
  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },
  context: { type: Schema.Types.Mixed, default: {} },
  requiresEscalation: { type: Boolean, default: false },
  escalationPolicy: { type: String, default: null },
  archiveState: { type: String, enum: ['HOT', 'ARCHIVED'], default: 'HOT', index: true },
  archivedAt: { type: Date, default: null },
  archiveLocator: { type: String, default: null },
  archiveChecksum: { type: String, default: null },

  // Legacy fields retained for read compatibility and non-destructive migration.
  auditId: { type: String, index: true },
  adminUserId: { type: String },
  action: { type: String, enum: ADMIN_AUDIT_ACTIONS },
  targetRequestId: { type: String },
  reason: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: { createdAt: true, updatedAt: false } });

adminAuditLogSchema.index({ adminId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetId: 1, targetType: 1, createdAt: -1 });
adminAuditLogSchema.index({ actionType: 1, createdAt: -1 });
adminAuditLogSchema.index({ archiveState: 1, createdAt: 1 });
adminAuditLogSchema.index({ targetRequestId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

export const AdminAuditLogModel = mongoose.models.AdminAuditLog
  || mongoose.model<AdminAuditLogRecord>('AdminAuditLog', adminAuditLogSchema, 'admin_audit_logs');

/** Tạo một bản ghi audit; mọi producer mới nên gọi qua audit-log.service. */
export async function createAdminAuditLog(
  data: Omit<AdminAuditLogRecord, 'createdAt'> & { createdAt?: Date },
  session?: ClientSession
): Promise<AdminAuditLogRecord> {
  if (session) {
    const document = new AdminAuditLogModel(data);
    await document.save({ session });
    return document.toObject() as AdminAuditLogRecord;
  }
  return AdminAuditLogModel.create(data);
}

/** Tìm một action canonical theo idempotency key. */
export async function findAdminAuditLogByActionId(
  actionId: string,
  session?: ClientSession
): Promise<AdminAuditLogRecord | null> {
  const query = AdminAuditLogModel.findOne({ actionId });
  if (session) query.session(session);
  return query.lean<AdminAuditLogRecord>().exec();
}

/** Lấy audit của một request, gồm cả canonical record và document legacy tương thích. */
export async function findAuditLogsByRequestId(
  requestId: string
): Promise<AdminAuditLogRecord[]> {
  return AdminAuditLogModel.find({
    $or: [
      { targetId: requestId },
      { targetRequestId: requestId }
    ]
  })
    .sort({ createdAt: -1 })
    .lean<AdminAuditLogRecord[]>()
    .exec();
}
