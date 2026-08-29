import mongoose, { Schema } from 'mongoose';

export type AuditorPenaltyLedgerEntryType = 'PENALTY' | 'REWARD';
export type AuditorPenaltyLedgerStatus = 'PENDING' | 'COMPLETED';

export type AuditorPenaltyLedgerEntry = {
  ledgerId: string;
  auditorUserId: string;
  fieldReportId: string;
  fieldCaseId: string;
  milestoneIndex: number;
  entryType: AuditorPenaltyLedgerEntryType;
  amount: string;
  txHash: string | null;
  reasonCode: string;
  status: AuditorPenaltyLedgerStatus;
  payableAt: Date | null;
  createdAt: Date;
};

const auditorPenaltyLedgerSchema = new Schema<AuditorPenaltyLedgerEntry>({
  ledgerId: { type: String, required: true, unique: true },
  auditorUserId: { type: String, required: true },
  fieldReportId: { type: String, required: true },
  fieldCaseId: { type: String, required: true },
  milestoneIndex: { type: Number, required: true, min: 0 },
  entryType: { type: String, required: true, enum: ['PENALTY', 'REWARD'] },
  amount: { type: String, required: true },
  txHash: { type: String, default: null },
  reasonCode: { type: String, required: true },
  status: { type: String, enum: ['PENDING', 'COMPLETED'], required: true, default: 'PENDING' },
  payableAt: { type: Date, default: null },
  createdAt: { type: Date, required: true }
});

auditorPenaltyLedgerSchema.index(
  { fieldReportId: 1, entryType: 1 },
  { name: 'penalty_field_report_unique', unique: true, partialFilterExpression: { entryType: 'PENALTY' } }
);
auditorPenaltyLedgerSchema.index(
  { fieldReportId: 1, entryType: 1, auditorUserId: 1 },
  { name: 'reward_field_report_auditor_unique', unique: true, partialFilterExpression: { entryType: 'REWARD' } }
);
auditorPenaltyLedgerSchema.index({ auditorUserId: 1, entryType: 1 });
auditorPenaltyLedgerSchema.index({ entryType: 1, status: 1, payableAt: 1 });

const AuditorPenaltyLedgerModel = mongoose.models?.AuditorPenaltyLedger
  || mongoose.model<AuditorPenaltyLedgerEntry>('AuditorPenaltyLedger', auditorPenaltyLedgerSchema);

/** Ghi một khoản thưởng hoặc phạt idempotent theo khóa nghiệp vụ tương ứng. */
export async function appendAuditorLedgerEntry(entry: AuditorPenaltyLedgerEntry): Promise<AuditorPenaltyLedgerEntry> {
  const createdEntry = await AuditorPenaltyLedgerModel.create(entry);
  return createdEntry.toObject() as AuditorPenaltyLedgerEntry;
}

/** Giành ledger PENDING trước side effect on-chain; REWARD tách theo Auditor còn PENALTY giữ một dòng mỗi biên bản. */
export async function claimAuditorLedgerEntry(entry: AuditorPenaltyLedgerEntry): Promise<boolean> {
  const identity = entry.entryType === 'REWARD'
    ? { fieldReportId: entry.fieldReportId, entryType: entry.entryType, auditorUserId: entry.auditorUserId }
    : { fieldReportId: entry.fieldReportId, entryType: entry.entryType };
  const result = await AuditorPenaltyLedgerModel.updateOne(
    identity,
    { $setOnInsert: entry },
    { upsert: true }
  ).exec();
  return result.upsertedCount === 1;
}

/** Đánh dấu đúng ledger hoàn tất sau side effect on-chain, không thể hoàn tất nhầm REWARD của Auditor khác. */
export async function completeAuditorLedgerEntry(
  fieldReportId: string,
  entryType: AuditorPenaltyLedgerEntryType,
  auditorUserId: string | null,
  txHash: string | null
): Promise<void> {
  const identity = entryType === 'REWARD'
    ? { fieldReportId, entryType, auditorUserId, status: 'PENDING' }
    : { fieldReportId, entryType, status: 'PENDING' };
  await AuditorPenaltyLedgerModel.updateOne(
    identity,
    { $set: { status: 'COMPLETED', txHash } }
  ).exec();
}

/** Lấy các khoản thưởng đã qua thời gian chờ để worker cộng DCT vào ví Auditor. */
export async function findClaimableAuditorRewardLedgerEntries(
  now: Date,
  limit: number
): Promise<AuditorPenaltyLedgerEntry[]> {
  return AuditorPenaltyLedgerModel.find({
    entryType: 'REWARD',
    status: 'PENDING',
    payableAt: { $lte: now }
  })
    .sort({ payableAt: 1 })
    .limit(limit)
    .lean<AuditorPenaltyLedgerEntry[]>()
    .exec();
}

/** Đọc đúng ledger idempotent theo khóa nghiệp vụ thay vì tải toàn bộ sổ của Auditor. */
export async function findAuditorLedgerEntryByFieldReportAndType(
  fieldReportId: string,
  entryType: AuditorPenaltyLedgerEntryType,
  auditorUserId: string | null
): Promise<AuditorPenaltyLedgerEntry | null> {
  const identity = entryType === 'REWARD'
    ? { fieldReportId, entryType, auditorUserId }
    : { fieldReportId, entryType };
  return AuditorPenaltyLedgerModel.findOne(identity)
    .lean<AuditorPenaltyLedgerEntry>()
    .exec();
}

/** Đếm khoản phạt trên index để áp dụng quy tắc cấm sau số lần vi phạm cho phép. */
export async function countAuditorPenalties(auditorUserId: string): Promise<number> {
  return AuditorPenaltyLedgerModel.countDocuments({ auditorUserId, entryType: 'PENALTY' }).exec();
}

/** Liệt kê sổ cái theo thứ tự mới nhất, có thể lọc loại nghiệp vụ để tận dụng index compound. */
export async function listAuditorLedgerEntries(
  auditorUserId: string,
  entryType?: AuditorPenaltyLedgerEntryType
): Promise<AuditorPenaltyLedgerEntry[]> {
  return AuditorPenaltyLedgerModel.find({ auditorUserId, ...(entryType ? { entryType } : {}) })
    .sort({ createdAt: -1 })
    .lean<AuditorPenaltyLedgerEntry[]>()
    .exec();
}

/** Cộng phần thưởng đã credit trực tiếp trong Mongo để đường tạo payout không tải toàn bộ ledger lịch sử. */
export async function sumCompletedAuditorRewardLedgerEntries(auditorUserId: string): Promise<number> {
  const [result] = await AuditorPenaltyLedgerModel.aggregate<{ total: number }>([
    { $match: { auditorUserId, entryType: 'REWARD', status: 'COMPLETED' } },
    { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } }
  ]).exec();
  return result?.total ?? 0;
}
