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
  createdAt: { type: Date, required: true }
});

auditorPenaltyLedgerSchema.index({ fieldReportId: 1, entryType: 1 }, { unique: true });
auditorPenaltyLedgerSchema.index({ auditorUserId: 1, entryType: 1 });

const AuditorPenaltyLedgerModel = mongoose.models?.AuditorPenaltyLedger
  || mongoose.model<AuditorPenaltyLedgerEntry>('AuditorPenaltyLedger', auditorPenaltyLedgerSchema);

/** Ghi một khoản thưởng hoặc phạt idempotent theo biên bản và loại nghiệp vụ. */
export async function appendAuditorLedgerEntry(entry: AuditorPenaltyLedgerEntry): Promise<AuditorPenaltyLedgerEntry> {
  const createdEntry = await AuditorPenaltyLedgerModel.create(entry);
  return createdEntry.toObject() as AuditorPenaltyLedgerEntry;
}

/** Giành một sổ cái PENDING idempotent trước side effect on-chain để hai worker không thể cộng nợ phạt hai lần. */
export async function claimAuditorLedgerEntry(entry: AuditorPenaltyLedgerEntry): Promise<boolean> {
  const result = await AuditorPenaltyLedgerModel.updateOne(
    { fieldReportId: entry.fieldReportId, entryType: entry.entryType },
    { $setOnInsert: entry },
    { upsert: true }
  ).exec();
  return result.upsertedCount === 1;
}

/** Đánh dấu ledger hoàn tất sau khi slash và phần nợ thiếu đã durable để lần gọi sau chỉ đọc kết quả cũ. */
export async function completeAuditorLedgerEntry(
  fieldReportId: string,
  entryType: AuditorPenaltyLedgerEntryType,
  txHash: string | null
): Promise<void> {
  await AuditorPenaltyLedgerModel.updateOne(
    { fieldReportId, entryType, status: 'PENDING' },
    { $set: { status: 'COMPLETED', txHash } }
  ).exec();
}

/** Đếm khoản phạt trên index để áp dụng quy tắc cấm sau số lần vi phạm cho phép. */
export async function countAuditorPenalties(auditorUserId: string): Promise<number> {
  return AuditorPenaltyLedgerModel.countDocuments({ auditorUserId, entryType: 'PENALTY' }).exec();
}

/** Liệt kê sổ cái theo thứ tự mới nhất để đối chiếu nghiệp vụ và event on-chain. */
export async function listAuditorLedgerEntries(auditorUserId: string): Promise<AuditorPenaltyLedgerEntry[]> {
  return AuditorPenaltyLedgerModel.find({ auditorUserId })
    .sort({ createdAt: -1 })
    .lean<AuditorPenaltyLedgerEntry[]>()
    .exec();
}
