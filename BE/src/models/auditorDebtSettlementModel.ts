import mongoose, { Schema } from 'mongoose';

/**
 * SUBMITTING states are durable crash barriers. A process that dies after
 * broadcasting an external transaction must be reconciled manually instead
 * of retrying a transfer whose outcome is unknown.
 */
export type AuditorDebtSettlementStatus =
  | 'PENDING_WITHDRAWAL'
  | 'WITHDRAWAL_SUBMITTING'
  | 'WAITING_WITHDRAWAL'
  | 'PENDING_FUNDING'
  | 'FUNDING_SUBMITTING'
  | 'FUNDING_SUBMITTED'
  | 'COMPLETED'
  | 'MANUAL_REVIEW';

export type AuditorDebtSettlement = {
  settlementId: string;
  auditorUserId: string;
  payoutId: string | null;
  withdrawalAmountVnd: number;
  debtAmountVnd: number;
  withdrawalTxHash: string | null;
  fundRewardPoolTxHash: string | null;
  status: AuditorDebtSettlementStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const auditorDebtSettlementSchema = new Schema<AuditorDebtSettlement>({
  settlementId: { type: String, required: true, unique: true },
  auditorUserId: { type: String, required: true, index: true },
  payoutId: { type: String, default: null },
  withdrawalAmountVnd: { type: Number, required: true, min: 1 },
  debtAmountVnd: { type: Number, required: true, min: 1 },
  withdrawalTxHash: { type: String, default: null },
  fundRewardPoolTxHash: { type: String, default: null },
  status: {
    type: String,
    required: true,
    enum: [
      'PENDING_WITHDRAWAL',
      'WITHDRAWAL_SUBMITTING',
      'WAITING_WITHDRAWAL',
      'PENDING_FUNDING',
      'FUNDING_SUBMITTING',
      'FUNDING_SUBMITTED',
      'COMPLETED',
      'MANUAL_REVIEW'
    ],
    index: true
  },
  errorMessage: { type: String, default: null }
}, { timestamps: true });

const AuditorDebtSettlementModel = mongoose.models?.AuditorDebtSettlement
  || mongoose.model<AuditorDebtSettlement>('AuditorDebtSettlement', auditorDebtSettlementSchema);

/** Tạo state machine settlement sau khi guard lock đã được giành; record này là mốc khôi phục sau restart. */
export async function createAuditorDebtSettlement(settlement: AuditorDebtSettlement): Promise<AuditorDebtSettlement> {
  const created = await AuditorDebtSettlementModel.create(settlement);
  return created.toObject() as AuditorDebtSettlement;
}

/** Lấy settlement theo lockRefId để worker chỉ resume đúng nghiệp vụ đang giữ wallet lock. */
export async function findAuditorDebtSettlementById(settlementId: string): Promise<AuditorDebtSettlement | null> {
  return AuditorDebtSettlementModel.findOne({ settlementId }).lean<AuditorDebtSettlement>().exec();
}

/** Cập nhật state có điều kiện để retry cũ không thể ghi đè trạng thái terminal. */
export async function updateAuditorDebtSettlement(
  settlementId: string,
  expectedStatus: AuditorDebtSettlementStatus,
  patch: Partial<Pick<AuditorDebtSettlement, 'status' | 'withdrawalTxHash' | 'fundRewardPoolTxHash' | 'errorMessage'>>
): Promise<AuditorDebtSettlement | null> {
  const updated = await AuditorDebtSettlementModel.findOneAndUpdate(
    { settlementId, status: expectedStatus },
    { $set: patch },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorDebtSettlement : null;
}

/** Lấy settlement chưa kết thúc để scheduler resume ngay cả khi process chết giữa các giao dịch. */
export async function findRecoverableAuditorDebtSettlements(limit: number): Promise<AuditorDebtSettlement[]> {
  return AuditorDebtSettlementModel.find({ status: { $in: ['WAITING_WITHDRAWAL', 'PENDING_FUNDING', 'FUNDING_SUBMITTED'] } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean<AuditorDebtSettlement[]>()
    .exec();
}

/**
 * Đưa các cửa sổ gửi giao dịch đã quá lâu vào manual review vì khi đó không thể
 * phân biệt an toàn giữa request chưa tới chain và transaction đã được chấp nhận.
 */
export async function moveUncertainAuditorDebtSettlementsToManualReview(updatedBefore: Date): Promise<void> {
  await AuditorDebtSettlementModel.updateMany(
    {
      status: { $in: ['WITHDRAWAL_SUBMITTING', 'FUNDING_SUBMITTING'] },
      updatedAt: { $lt: updatedBefore }
    },
    {
      $set: {
        status: 'MANUAL_REVIEW',
        errorMessage: 'Missing durable transaction hash after an interrupted on-chain submission; manual reconciliation is required.'
      }
    }
  ).exec();
}
