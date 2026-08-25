import mongoose, { Schema } from 'mongoose';

export type AuditorPayoutType = 'REWARD' | 'STAKE_WITHDRAWAL';
export type AuditorPayoutStatus = 'PENDING' | 'TRANSFERRING' | 'TRANSFERRED' | 'BURNED' | 'FAILED' | 'MANUAL_REVIEW' | 'CANCELLED';

export type AuditorPayout = {
  payoutId: string;
  auditorUserId: string;
  payoutType: AuditorPayoutType;
  sourceRefId: string;
  amountVnd: number;
  feeVnd: number;
  netAmountVnd: number;
  bankSnapshot: {
    bankName: string;
    bankCode: string;
    bankAccountNumber: string;
    accountHolderName: string;
  };
  status: AuditorPayoutStatus;
  payosTransferId: string | null;
  transferIdempotencyKey: string;
  onchainTxHash: string | null;
  burnTxHash: string | null;
  attemptNumber: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const auditorPayoutSchema = new Schema<AuditorPayout>({
  payoutId: { type: String, required: true, unique: true },
  auditorUserId: { type: String, required: true, index: true },
  payoutType: { type: String, required: true, enum: ['REWARD', 'STAKE_WITHDRAWAL'] },
  sourceRefId: { type: String, required: true },
  amountVnd: { type: Number, required: true, min: 1 },
  feeVnd: { type: Number, required: true, min: 0 },
  netAmountVnd: { type: Number, required: true, min: 1 },
  bankSnapshot: {
    bankName: { type: String, required: true },
    bankCode: { type: String, required: true },
    bankAccountNumber: { type: String, required: true },
    accountHolderName: { type: String, required: true }
  },
  status: { type: String, required: true, enum: ['PENDING', 'TRANSFERRING', 'TRANSFERRED', 'BURNED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED'], index: true },
  payosTransferId: { type: String, default: null, index: true },
  transferIdempotencyKey: { type: String, required: true },
  onchainTxHash: { type: String, default: null },
  burnTxHash: { type: String, default: null },
  attemptNumber: { type: Number, required: true, min: 0, default: 0 },
  errorMessage: { type: String, default: null }
}, { timestamps: true });

auditorPayoutSchema.index({ payoutType: 1, sourceRefId: 1 }, { unique: true });
auditorPayoutSchema.index({ auditorUserId: 1, status: 1 });
auditorPayoutSchema.index(
  { onchainTxHash: 1 },
  { unique: true, partialFilterExpression: { onchainTxHash: { $type: 'string' } } }
);

const AuditorPayoutModel = mongoose.models?.AuditorPayout
  || mongoose.model<AuditorPayout>('AuditorPayout', auditorPayoutSchema);

export async function createAuditorPayout(payout: AuditorPayout): Promise<AuditorPayout> {
  const created = await AuditorPayoutModel.create(payout);
  return created.toObject() as AuditorPayout;
}

export async function findAuditorPayoutById(payoutId: string): Promise<AuditorPayout | null> {
  return AuditorPayoutModel.findOne({ payoutId }).lean<AuditorPayout>().exec();
}

export async function findAuditorPayoutByPayosTransferId(payosTransferId: string): Promise<AuditorPayout | null> {
  return AuditorPayoutModel.findOne({ payosTransferId }).lean<AuditorPayout>().exec();
}

export async function findAuditorPayoutBySource(
  payoutType: AuditorPayoutType,
  sourceRefId: string
): Promise<AuditorPayout | null> {
  return AuditorPayoutModel.findOne({ payoutType, sourceRefId }).lean<AuditorPayout>().exec();
}

/** Tìm payout đã được gắn với Withdrawn event để projector không tạo lệnh chi trả thứ hai. */
export async function findAuditorPayoutByOnchainTxHash(onchainTxHash: string): Promise<AuditorPayout | null> {
  return AuditorPayoutModel.findOne({ onchainTxHash }).lean<AuditorPayout>().exec();
}

/** Đọc số lượng hữu hạn payout chưa enqueue để worker phục hồi sau Redis hoặc process restart. */
export async function findPendingAuditorPayouts(limit: number): Promise<AuditorPayout[]> {
  return AuditorPayoutModel.find({ status: 'PENDING', onchainTxHash: { $ne: null } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean<AuditorPayout[]>()
    .exec();
}

/** Chỉ worker sở hữu job mới được chuyển trạng thái để chống kết quả provider stale. */
export async function claimAuditorPayoutForTransfer(
  payoutId: string,
  attemptNumber: number
): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: { $in: ['PENDING', 'FAILED'] }, attemptNumber: { $lt: attemptNumber } },
    { $set: { status: 'TRANSFERRING', attemptNumber, errorMessage: null } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

export async function updateAuditorPayout(
  payoutId: string,
  patch: Partial<Pick<AuditorPayout, 'status' | 'payosTransferId' | 'burnTxHash' | 'errorMessage' | 'attemptNumber' | 'onchainTxHash' | 'transferIdempotencyKey'>>
): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId },
    { $set: patch },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/**
 * Chỉ xác nhận giao dịch rút cho payout đã chuẩn bị trước để worker không
 * chuyển tiền khi token chưa về ví. MANUAL_REVIEW chỉ được mở lại khi chưa có
 * hash on-chain, tức là stale-lock sweeper chưa thể biết UserOperation có
 * thành công hay không; các manual review PayOS luôn đã có hash nên không khớp.
 */
export async function linkAuditorPayoutToOnchainWithdrawal(
  payoutId: string,
  onchainTxHash: string
): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: { $in: ['PENDING', 'MANUAL_REVIEW'] }, onchainTxHash: null },
    { $set: { onchainTxHash, status: 'PENDING', errorMessage: null } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Hủy payout chưa gửi PayOS khi UserOperation rút cọc bị reject rõ ràng. */
export async function cancelAuditorPayout(payoutId: string, errorMessage: string): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: 'PENDING', onchainTxHash: null },
    { $set: { status: 'CANCELLED', errorMessage } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Mở lại duy nhất payout đã được PayOS chuyển thành công để admin thử burn DCT có kiểm soát. */
export async function reopenAuditorPayoutForManualBurn(
  payoutId: string,
  payosTransferId: string
): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    {
      payoutId,
      status: 'MANUAL_REVIEW',
      onchainTxHash: { $type: 'string' },
      payosTransferId
    },
    { $set: { status: 'TRANSFERRED', errorMessage: null } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Xoay idempotency key sau lỗi PayOS đã xác nhận để provider nhận retry như một lệnh mới. */
export async function rotateAuditorPayoutTransferIdempotencyKey(payoutId: string, transferIdempotencyKey: string): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: { $in: ['TRANSFERRING', 'FAILED'] } },
    { $set: { transferIdempotencyKey } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Chỉ ghi PayOS FAILED khi payout còn đang chuyển tiền, tránh callback đến muộn ghi đè BURNED. */
export async function markAuditorPayoutFailedIfTransferring(
  payoutId: string,
  errorMessage: string
): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: 'TRANSFERRING' },
    { $set: { status: 'FAILED', errorMessage } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Claim atomic quyền burn sau khi PayOS đã xác nhận để webhook/job trùng không burn hai lần. */
export async function claimAuditorPayoutForBurn(payoutId: string): Promise<AuditorPayout | null> {
  const updated = await AuditorPayoutModel.findOneAndUpdate(
    { payoutId, status: 'TRANSFERRING' },
    { $set: { status: 'TRANSFERRED', errorMessage: null } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayout : null;
}

/** Liệt kê payout của chính auditor cho màn hình lịch sử tiền, dùng index { auditorUserId, status }. */
export async function listAuditorPayoutsByUserId(auditorUserId: string, limitCount: number): Promise<AuditorPayout[]> {
  return AuditorPayoutModel.find({ auditorUserId })
    .sort({ createdAt: -1 })
    .limit(limitCount)
    .lean<AuditorPayout[]>()
    .exec();
}
