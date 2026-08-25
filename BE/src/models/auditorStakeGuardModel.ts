import mongoose, { Schema } from 'mongoose';

export type AuditorWalletLock = 'UNSTAKING' | 'WITHDRAWING' | 'PAYOUT_IN_FLIGHT' | 'DEBT_SETTLING' | 'ACCOUNT_UPDATING';

export type AuditorStakeGuard = {
  auditorUserId: string;
  openCaseIds: string[];
  penaltyDebtVnd: number;
  lastSettledDebtSettlementId: string | null;
  walletLock: AuditorWalletLock | null;
  lockRefId: string | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const auditorStakeGuardSchema = new Schema<AuditorStakeGuard>({
  auditorUserId: { type: String, required: true, unique: true },
  openCaseIds: { type: [String], default: [] },
  penaltyDebtVnd: { type: Number, required: true, min: 0, default: 0 },
  lastSettledDebtSettlementId: { type: String, default: null },
  walletLock: { type: String, enum: ['UNSTAKING', 'WITHDRAWING', 'PAYOUT_IN_FLIGHT', 'DEBT_SETTLING', 'ACCOUNT_UPDATING'], default: null },
  lockRefId: { type: String, default: null },
  lockedAt: { type: Date, default: null }
}, { timestamps: true });

auditorStakeGuardSchema.index({ penaltyDebtVnd: 1, walletLock: 1 });
auditorStakeGuardSchema.index({ walletLock: 1, lockedAt: 1 });

const AuditorStakeGuardModel = mongoose.models?.AuditorStakeGuard
  || mongoose.model<AuditorStakeGuard>('AuditorStakeGuard', auditorStakeGuardSchema);

/** Khởi tạo guard idempotent cho cả Auditor cũ lẫn luồng đăng ký mới mà không đọc-rồi-ghi. */
export async function initializeAuditorStakeGuard(auditorUserId: string): Promise<void> {
  await AuditorStakeGuardModel.updateOne(
    { auditorUserId },
    {
      $setOnInsert: {
        auditorUserId,
        openCaseIds: [],
        penaltyDebtVnd: 0,
        lastSettledDebtSettlementId: null,
        walletLock: null,
        lockRefId: null,
        lockedAt: null
      }
    },
    { upsert: true }
  ).exec();
}

/** Đọc guard để giải thích lỗi nghiệp vụ; mọi chuyển trạng thái vẫn dùng update có điều kiện riêng. */
export async function findAuditorStakeGuardByUserId(auditorUserId: string): Promise<AuditorStakeGuard | null> {
  return AuditorStakeGuardModel.findOne({ auditorUserId }).lean<AuditorStakeGuard>().exec();
}

/** Giành khóa unbonding khi ví không có vụ mở, nợ phạt hoặc thao tác tài sản cạnh tranh. */
export async function acquireAuditorUnstakeLock(auditorUserId: string, lockRefId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, openCaseIds: { $size: 0 }, penaltyDebtVnd: 0, walletLock: null },
    { $set: { walletLock: 'UNSTAKING', lockRefId, lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Giành khóa trước khi gửi withdraw on-chain để DCT không thể bị dùng trong cửa sổ chờ payout. */
export async function acquireAuditorWithdrawalLock(auditorUserId: string, payoutId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, openCaseIds: { $size: 0 }, penaltyDebtVnd: 0, walletLock: null },
    { $set: { walletLock: 'WITHDRAWING', lockRefId: payoutId, lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Khóa ngắn hạn trong lúc thay tài khoản ngân hàng để snapshot payout không thể lấy dữ liệu giữa hai phiên bản. */
export async function acquireAuditorPayoutAccountUpdateLock(auditorUserId: string, lockRefId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, walletLock: null },
    { $set: { walletLock: 'ACCOUNT_UPDATING', lockRefId, lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Ghi nhận vụ đang xử chỉ khi ví chưa bị thao tác tài sản khác khóa, để Mongo quyết định cuộc đua. */
export async function acquireAuditorOpenCase(auditorUserId: string, caseId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, walletLock: null, openCaseIds: { $ne: caseId } },
    { $addToSet: { openCaseIds: caseId } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Nhả case lock sau khi phán quyết đã chốt; chỉ case đã tồn tại mới bị pull. */
export async function releaseAuditorOpenCase(auditorUserId: string, caseId: string): Promise<void> {
  await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, openCaseIds: caseId },
    { $pull: { openCaseIds: caseId } },
    { returnDocument: 'after' }
  ).exec();
}

/** Chuyển lock rút cọc sang trạng thái payout sau khi Withdrawn event đã được xác nhận. */
export async function promoteAuditorWithdrawalLockToPayout(auditorUserId: string, payoutId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, walletLock: 'WITHDRAWING', lockRefId: payoutId },
    { $set: { walletLock: 'PAYOUT_IN_FLIGHT', lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Chuyển lock thu nợ sang payout cash còn lại để DCT chỉ được mở khi payout đã burn xong. */
export async function promoteAuditorDebtSettlementLockToPayout(auditorUserId: string, settlementId: string, payoutId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, walletLock: 'DEBT_SETTLING', lockRefId: settlementId },
    { $set: { walletLock: 'PAYOUT_IN_FLIGHT', lockRefId: payoutId, lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Nhả đúng lock đang sở hữu để callback/job cũ không vô tình mở khóa một nghiệp vụ mới. */
export async function releaseAuditorWalletLock(
  auditorUserId: string,
  lockRefId: string,
  expectedLock?: AuditorWalletLock
): Promise<void> {
  await AuditorStakeGuardModel.findOneAndUpdate(
    {
      auditorUserId,
      lockRefId,
      walletLock: expectedLock ?? { $ne: null }
    },
    { $set: { walletLock: null, lockRefId: null, lockedAt: null } },
    { returnDocument: 'after' }
  ).exec();
}

/** Nhả unbonding lock khi projector đã xác nhận event hoặc request gửi chain thất bại rõ ràng. */
export async function releaseAuditorUnstakeLock(auditorUserId: string, lockRefId: string): Promise<void> {
  await releaseAuditorWalletLock(auditorUserId, lockRefId, 'UNSTAKING');
}

/** Kiểm tra ví có lock bất kể payout đang ở retry hay manual review để chặn mọi đường tiêu DCT. */
export async function hasAuditorWalletLock(auditorUserId: string): Promise<boolean> {
  return Boolean(await AuditorStakeGuardModel.exists({ auditorUserId, walletLock: { $ne: null } }));
}

/** Tăng nợ phạt bằng toán tử Mongo nguyên tử sau khi khoản thiếu đã được tính từ slash on-chain. */
export async function increaseAuditorPenaltyDebt(auditorUserId: string, amountVnd: number): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId },
    { $inc: { penaltyDebtVnd: amountVnd } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Giành lock thu nợ để chỉ một worker có quyền rút DCT pending của Auditor tại một thời điểm. */
export async function acquireAuditorDebtSettlementLock(auditorUserId: string, settlementId: string): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    { auditorUserId, openCaseIds: { $size: 0 }, penaltyDebtVnd: { $gt: 0 }, walletLock: null },
    { $set: { walletLock: 'DEBT_SETTLING', lockRefId: settlementId, lockedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Trừ nợ một lần sau khi fundRewardPool đã xác nhận, không cho số dư âm. */
export async function settleAuditorPenaltyDebt(
  auditorUserId: string,
  settlementId: string,
  amountVnd: number
): Promise<AuditorStakeGuard | null> {
  const updated = await AuditorStakeGuardModel.findOneAndUpdate(
    {
      auditorUserId,
      walletLock: 'DEBT_SETTLING',
      lockRefId: settlementId,
      penaltyDebtVnd: { $gte: amountVnd },
      lastSettledDebtSettlementId: { $ne: settlementId }
    },
    { $inc: { penaltyDebtVnd: -amountVnd }, $set: { lastSettledDebtSettlementId: settlementId } },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorStakeGuard : null;
}

/** Lấy các lock cũ có thể là orphan để worker kiểm tra payout tương ứng trước khi giải phóng có điều kiện. */
export async function findStaleAuditorStakeGuards(lockedBefore: Date, limit: number): Promise<AuditorStakeGuard[]> {
  return AuditorStakeGuardModel.find({ walletLock: { $ne: null }, lockedAt: { $lte: lockedBefore } })
    .sort({ lockedAt: 1 })
    .limit(limit)
    .lean<AuditorStakeGuard[]>()
    .exec();
}

/** Lấy các Auditor còn nợ nhưng không bị lock để worker chỉ bắt đầu settlement khi không có thao tác cạnh tranh. */
export async function findAuditorPenaltyDebtCandidates(limit: number): Promise<AuditorStakeGuard[]> {
  return AuditorStakeGuardModel.find({ penaltyDebtVnd: { $gt: 0 }, walletLock: null })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean<AuditorStakeGuard[]>()
    .exec();
}
