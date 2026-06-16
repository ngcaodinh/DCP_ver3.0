import mongoose, { Schema } from 'mongoose';

/**
 * Loại hành động admin cần ghi audit.
 * MANUAL_APPROVE: admin approve manual review → retry PayOS
 * MANUAL_REJECT: admin reject disbursement
 *
 * [B2-fix #2] Bổ sung các action cho override voting — phải có trong trail để đáp ứng compliance.
 * OVERRIDE_VOTE_APPROVE: commissioner vote APPROVE cho override request
 * OVERRIDE_VOTE_REJECT: commissioner vote REJECT cho override request
 * OVERRIDE_EXPIRED: override request hết hạn do commissioner set thay đổi hoặc timeout
 */
export type AdminAuditAction =
  | 'MANUAL_APPROVE'
  | 'MANUAL_REJECT'
  | 'OVERRIDE_VOTE_APPROVE'
  | 'OVERRIDE_VOTE_REJECT'
  | 'OVERRIDE_EXPIRED';

/**
 * Bản ghi audit log cho hành động admin trên disbursement.
 * Mục đích: đáp ứng yêu cầu compliance — mọi hành động manual cần có trail.
 */
export type AdminAuditLogRecord = {
  auditId: string;
  adminUserId: string;
  action: AdminAuditAction;
  targetRequestId: string;     // Disbursement requestId bị tác động
  reason: string | null;       // Lý do (bắt buộc với MANUAL_REJECT)
  metadata: Record<string, unknown>;
  createdAt: Date;
};

const adminAuditLogSchema = new Schema<AdminAuditLogRecord>({
  auditId: { type: String, required: true, unique: true },
  adminUserId: { type: String, required: true, index: true },
  action: {
    type: String,
    required: true,
    enum: ['MANUAL_APPROVE', 'MANUAL_REJECT', 'OVERRIDE_VOTE_APPROVE', 'OVERRIDE_VOTE_REJECT', 'OVERRIDE_EXPIRED'],
    index: true
  },
  targetRequestId: { type: String, required: true, index: true },
  reason: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: { createdAt: true, updatedAt: false } });

adminAuditLogSchema.index({ targetRequestId: 1, createdAt: -1 });
// Index để query nhanh các override actions (cho E8 audit log page)
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

const AdminAuditLogMongoModel = mongoose.model<AdminAuditLogRecord>(
  'AdminAuditLog',
  adminAuditLogSchema,
  'admin_audit_logs'
);

/** Tạo một bản ghi audit log mới. */
export async function createAdminAuditLog(
  data: Omit<AdminAuditLogRecord, 'createdAt'>
): Promise<AdminAuditLogRecord> {
  return AdminAuditLogMongoModel.create(data);
}

/** Lấy tất cả audit log cho một disbursement requestId theo thứ tự mới nhất trước. */
export async function findAuditLogsByRequestId(
  requestId: string
): Promise<AdminAuditLogRecord[]> {
  return AdminAuditLogMongoModel.find({ targetRequestId: requestId })
    .sort({ createdAt: -1 })
    .lean<AdminAuditLogRecord[]>()
    .exec();
}
