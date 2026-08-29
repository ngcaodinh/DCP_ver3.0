import crypto from 'crypto';
import mongoose, { Schema, type ClientSession } from 'mongoose';
import type { DisbursementEvidencePhoto, DisbursementRequestMode } from './disbursementModel';

export type DisbursementCreationIntentStatus = 'PREPARED' | 'BROADCAST' | 'CONFIRMED' | 'MATERIALIZED';

/** Dữ liệu off-chain phải được giữ bền vững trước transaction vì event contract không chứa thông tin ngân hàng/mục đích. */
export interface DisbursementCreationIntentPayload {
  projectId: string;
  onChainProjectId: number;
  organizationId: string;
  beneficiaryWalletAddress: string;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  evidencePhotos: DisbursementEvidencePhoto[];
  requestMode: DisbursementRequestMode;
  emergencyReason: string | null;
}

export interface DisbursementCreationIntent {
  intentId: string;
  status: DisbursementCreationIntentStatus;
  payload: DisbursementCreationIntentPayload;
  transactionHash: string | null;
  onChainRequestId: number | null;
  confirmedAt: Date | null;
  materializedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const disbursementCreationIntentSchema = new Schema<DisbursementCreationIntent>({
  intentId: { type: String, required: true, unique: true },
  status: { type: String, required: true, enum: ['PREPARED', 'BROADCAST', 'CONFIRMED', 'MATERIALIZED'] },
  // Payload được service tạo từ input đã validation; Mixed tránh nhân đôi một schema lồng rất dài.
  payload: { type: Schema.Types.Mixed, required: true },
  transactionHash: { type: String, default: null, index: true, sparse: true },
  onChainRequestId: { type: Number, default: null, index: true, sparse: true },
  confirmedAt: { type: Date, default: null },
  materializedAt: { type: Date, default: null },
  lastError: { type: String, default: null }
}, { collection: 'disbursement_creation_intents', timestamps: true, strict: 'throw' });

disbursementCreationIntentSchema.index({ status: 1, updatedAt: 1 });
disbursementCreationIntentSchema.index({ 'payload.evidenceCid': 1, createdAt: -1 });

export const DisbursementCreationIntentMongoModel = mongoose.models?.DisbursementCreationIntent
  || mongoose.model<DisbursementCreationIntent>('DisbursementCreationIntent', disbursementCreationIntentSchema);

/** Lưu intent trước side effect chain để reconciler luôn có đủ dữ liệu dựng lại record. */
export async function createDisbursementCreationIntent(payload: DisbursementCreationIntentPayload): Promise<DisbursementCreationIntent> {
  const created = await DisbursementCreationIntentMongoModel.create({
    intentId: crypto.randomUUID(), status: 'PREPARED', payload,
    transactionHash: null, onChainRequestId: null, confirmedAt: null, materializedAt: null, lastError: null
  });
  return created.toObject() as DisbursementCreationIntent;
}

/** Ghi hash ngay khi RPC trả về để restart chỉ reconcile receipt, tuyệt đối không broadcast lại. */
export async function markDisbursementCreationIntentBroadcast(intentId: string, transactionHash: string): Promise<void> {
  await DisbursementCreationIntentMongoModel.updateOne(
    { intentId, status: 'PREPARED' },
    { $set: { status: 'BROADCAST', transactionHash: transactionHash.toLowerCase(), lastError: null, updatedAt: new Date() } }
  ).exec();
}

/** Ghi event đã xác nhận; có thể gọi lại an toàn khi worker replay cùng transaction. */
export async function markDisbursementCreationIntentConfirmed(
  intentId: string,
  onChainRequestId: number,
  transactionHash?: string | null
): Promise<void> {
  await DisbursementCreationIntentMongoModel.updateOne(
    { intentId, status: { $in: ['PREPARED', 'BROADCAST', 'CONFIRMED'] } },
    {
      $set: {
        status: 'CONFIRMED',
        onChainRequestId,
        ...(transactionHash ? { transactionHash: transactionHash.toLowerCase() } : {}),
        confirmedAt: new Date(),
        lastError: null,
        updatedAt: new Date()
      }
    }
  ).exec();
}

/** Đánh dấu materialize sau transaction record/case/registry hoàn tất. */
export async function markDisbursementCreationIntentMaterialized(intentId: string, session?: ClientSession): Promise<void> {
  await DisbursementCreationIntentMongoModel.updateOne(
    { intentId },
    { $set: { status: 'MATERIALIZED', materializedAt: new Date(), lastError: null, updatedAt: new Date() } },
    session ? { session } : undefined
  ).exec();
}

/** Lưu lỗi có trần để worker có thể retry mà không làm document phình vô hạn. */
export async function markDisbursementCreationIntentError(intentId: string, errorMessage: string): Promise<void> {
  await DisbursementCreationIntentMongoModel.updateOne(
    { intentId, status: { $ne: 'MATERIALIZED' } },
    { $set: { lastError: errorMessage.slice(0, 500), updatedAt: new Date() } }
  ).exec();
}

export async function findDisbursementCreationIntentById(intentId: string): Promise<DisbursementCreationIntent | null> {
  return DisbursementCreationIntentMongoModel.findOne({ intentId }).lean<DisbursementCreationIntent>().exec();
}

export async function findDisbursementCreationIntentByTransactionHash(transactionHash: string): Promise<DisbursementCreationIntent | null> {
  return DisbursementCreationIntentMongoModel.findOne({ transactionHash: transactionHash.toLowerCase() }).lean<DisbursementCreationIntent>().exec();
}

/** Ghép event mồ côi với intent qua CID bất biến đã được server pin trước transaction. */
export async function findRecoverableDisbursementIntentByEvidenceCid(evidenceCid: string): Promise<DisbursementCreationIntent | null> {
  return DisbursementCreationIntentMongoModel.findOne({
    'payload.evidenceCid': evidenceCid,
    status: { $ne: 'MATERIALIZED' }
  }).sort({ createdAt: -1 }).lean<DisbursementCreationIntent>().exec();
}

/** Lấy intent chưa materialize theo trang nhỏ để recovery không quét vô hạn. */
export async function findRecoverableDisbursementCreationIntents(limitCount: number): Promise<DisbursementCreationIntent[]> {
  const limit = Number.isFinite(limitCount) ? Math.max(1, Math.min(100, Math.floor(limitCount))) : 25;
  return DisbursementCreationIntentMongoModel.find({ status: { $ne: 'MATERIALIZED' } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean<DisbursementCreationIntent[]>()
    .exec();
}
