import mongoose, { Schema } from 'mongoose';

/**
 * Hành động ghi log khi override request được xử lý bởi commissioner (off-chain).
 * OVERRIDE_VOTE_APPROVE: commissioner vote APPROVE → request được chấp thuận
 * OVERRIDE_VOTE_REJECT: commissioner vote REJECT → request bị từ chối
 * OVERRIDE_EXPIRED: override request hết hạn do commissioner set thay đổi
 */
export type MultisigOverrideLogAction =
  | 'OVERRIDE_VOTE_APPROVE'
  | 'OVERRIDE_VOTE_REJECT'
  | 'OVERRIDE_EXPIRED';

/**
 * Trạng thái resolution cuối cùng của override request.
 * APPROVED: đủ vote APPROVE → cho phép giải ngân
 * REJECTED: có vote REJECT → từ chối giải ngân
 * EXPIRED: commissioner set thay đổi → request không còn hiệu lực
 */
export type MultisigOverrideLogResolution = 'APPROVED' | 'REJECTED' | 'EXPIRED';

/**
 * Bản ghi log cho multisig override action trên Lane B (off-chain only).
 * Mục đích: đáp ứng yêu cầu compliance — mọi override resolution cần có trail.
 * Không ghi on-chain (txHash và blockNumber luôn null).
 */
export type MultisigOverrideLogRecord = {
  multisigOverrideLogId: string;
  overrideRequestId: string;
  projectId: string;
  operator: string;                // commissionerId của vote trigger resolution
  operatorRole: string;        // 'admin' | 'regulatory' | '' (rỗng khi EXPIRED — không track trong expiry flow, default trong schema)
  action: MultisigOverrideLogAction;
  resolution: MultisigOverrideLogResolution;
  reason: string;                 // Vote reason từ triggering vote
  txHash: string | null;          // null cho off-chain
  blockNumber: number | null;     // null cho off-chain
  eventTimestamp: Date;           // resolvedAt / expiredAt từ override request
  metadata: Record<string, unknown>;
  createdAt: Date;
};

const multisigOverrideLogSchema = new Schema<MultisigOverrideLogRecord>(
  {
    multisigOverrideLogId: { type: String, required: true, unique: true },
    overrideRequestId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    operator: { type: String, required: true },
    operatorRole: { type: String, required: false, default: '' },
    action: {
      type: String,
      required: true,
      enum: ['OVERRIDE_VOTE_APPROVE', 'OVERRIDE_VOTE_REJECT', 'OVERRIDE_EXPIRED']
    },
    resolution: {
      type: String,
      required: true,
      enum: ['APPROVED', 'REJECTED', 'EXPIRED']
    },
    reason: { type: String, required: true },
    txHash: { type: String, default: null },
    blockNumber: { type: Number, default: null },
    eventTimestamp: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Index cho unique constraint
multisigOverrideLogSchema.index({ multisigOverrideLogId: 1 }, { unique: true });
// Index cho query theo projectId + thời gian (audit trail)
multisigOverrideLogSchema.index({ projectId: 1, eventTimestamp: -1 });
// Index cho lookup nhanh theo overrideRequestId (field-level index: true ở trên)

const MultisigOverrideLogMongoModel = mongoose.model<MultisigOverrideLogRecord>(
  'MultisigOverrideLog',
  multisigOverrideLogSchema,
  'multisig_override_logs'
);

/**
 * Tạo một bản ghi multisig override log mới.
 */
export async function createMultisigOverrideLog(
  data: Omit<MultisigOverrideLogRecord, 'createdAt'>
): Promise<MultisigOverrideLogRecord> {
  return MultisigOverrideLogMongoModel.create(data);
}

/**
 * Lấy danh sách override logs cho một projectId theo thứ tự thời gian giảm dần.
 */
export async function findMultisigOverrideLogsByProjectId(
  projectId: string,
  limit = 20,
  skip = 0
): Promise<MultisigOverrideLogRecord[]> {
  return MultisigOverrideLogMongoModel.find({ projectId })
    .sort({ eventTimestamp: -1 })
    .skip(skip)
    .limit(Math.min(limit, 100))
    .lean<MultisigOverrideLogRecord[]>()
    .exec();
}

/**
 * Lấy override log theo overrideRequestId.
 */
export async function findMultisigOverrideLogByRequestId(
  overrideRequestId: string
): Promise<MultisigOverrideLogRecord | null> {
  return MultisigOverrideLogMongoModel.findOne({ overrideRequestId })
    .sort({ eventTimestamp: -1 })
    .lean<MultisigOverrideLogRecord | null>()
    .exec();
}
