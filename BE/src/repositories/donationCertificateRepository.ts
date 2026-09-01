import crypto from 'crypto';
import { DonationCertificateMongoModel, type DonationCertificateEmailStatus, type DonationCertificateFinalityMode, type DonationCertificateIssuanceStatus, type DonationCertificateRecord, type DonationCertificateSnapshot } from '../models/donationCertificateModel';

export interface PendingCertificateInput {
  chainId: number; transactionHash: string; donorUserId: string; expectedProjectId: string; expectedDonorAddress: string;
  expectedAmountRaw: string; expectedIsAnonymous: false; firstObservedAt: Date; requestedFinalityMode: DonationCertificateFinalityMode; allowConfirmationFallback: boolean;
}

/** Chuẩn hóa hash và address trước khi dùng làm khóa idempotency MongoDB. */
function normalizeHex(value: string): string { return value.trim().toLowerCase(); }

/** Tạo mã certificate không đoán được, vẫn giữ prefix năm UTC để phục vụ vận hành. */
function createCertificateId(observedAt: Date): string { return `DCP-${observedAt.getUTCFullYear()}-${crypto.randomBytes(16).toString('hex').toUpperCase()}`; }

/** Upsert candidate pending theo chain/transaction để hai đường ingestion không phát hành trùng. */
export async function upsertPendingDonationCertificate(input: PendingCertificateInput): Promise<{ record: DonationCertificateRecord; created: boolean }> {
  const transactionHash = normalizeHex(input.transactionHash);
  const expectedDonorAddress = normalizeHex(input.expectedDonorAddress);
  const existing = await DonationCertificateMongoModel.findOne({ chainId: input.chainId, transactionHash }).lean<DonationCertificateRecord>().exec();
  if (existing) return { record: existing, created: false };
  const now = new Date();
  try {
    const created = await DonationCertificateMongoModel.create({ ...input, transactionHash, expectedDonorAddress, certificateId: createCertificateId(input.firstObservedAt), schemaVersion: 1, issuanceStatus: 'PENDING_FINALITY', issuanceEmail: { status: 'NOT_QUEUED', attemptCount: 0 }, revocationEmail: { status: 'NOT_QUEUED', attemptCount: 0 }, finalityCheckCount: 0, nextFinalityCheckAt: now, createdAt: now, updatedAt: now });
    return { record: created.toObject() as DonationCertificateRecord, created: true };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const racedRecord = await DonationCertificateMongoModel.findOne({ chainId: input.chainId, transactionHash }).lean<DonationCertificateRecord>().exec();
    if (!racedRecord) throw error;
    return { record: racedRecord, created: false };
  }
}

/** Tìm record theo mã certificate đã được kiểm tra cú pháp ở service public. */
export async function findDonationCertificateById(certificateId: string): Promise<DonationCertificateRecord | null> { return DonationCertificateMongoModel.findOne({ certificateId }).lean<DonationCertificateRecord>().exec(); }

/** Tìm candidate theo khóa chain/hash đã chuẩn hóa để reconciliation dùng lại. */
export async function findDonationCertificateByTransaction(chainId: number, transactionHash: string): Promise<DonationCertificateRecord | null> { return DonationCertificateMongoModel.findOne({ chainId, transactionHash: normalizeHex(transactionHash) }).lean<DonationCertificateRecord>().exec(); }

/** Claim phát hành bằng CAS; snapshot chỉ được ghi duy nhất khi record còn pending. */
export async function claimDonationCertificateIssuance(certificateId: string, snapshot: DonationCertificateSnapshot, issuedAt: Date, reverifyUntilBlock: number): Promise<DonationCertificateRecord | null> {
  return DonationCertificateMongoModel.findOneAndUpdate({ certificateId, issuanceStatus: 'PENDING_FINALITY' }, { $set: { issuanceStatus: 'ISSUED', snapshot, issuedAt, reverifyUntilBlock, lastVerificationAt: issuedAt } }, { new: true }).lean<DonationCertificateRecord>().exec();
}

/** Thu hồi certificate theo CAS để trạng thái REVOKED không thể tự phục hồi. */
export async function markDonationCertificateRevoked(certificateId: string, reasonCode: NonNullable<DonationCertificateRecord['revocationReasonCode']>, revokedAt: Date): Promise<DonationCertificateRecord | null> {
  return DonationCertificateMongoModel.findOneAndUpdate({ certificateId, issuanceStatus: { $in: ['PENDING_FINALITY', 'ISSUED'] } }, { $set: { issuanceStatus: 'REVOKED', revocationReasonCode: reasonCode, revokedAt, lastVerificationAt: revokedAt } }, { new: true }).lean<DonationCertificateRecord>().exec();
}

/** Chặn candidate khi dữ liệu nghiệp vụ cần snapshot không tồn tại. */
export async function markDonationCertificateBlocked(certificateId: string, reasonCode: NonNullable<DonationCertificateRecord['blockedReasonCode']>, blockedAt: Date): Promise<DonationCertificateRecord | null> {
  return DonationCertificateMongoModel.findOneAndUpdate({ certificateId, issuanceStatus: 'PENDING_FINALITY' }, { $set: { issuanceStatus: 'BLOCKED', blockedReasonCode: reasonCode, blockedAt } }, { new: true }).lean<DonationCertificateRecord>().exec();
}

/** Chuyển delivery state có điều kiện để retry và worker song song không gửi trùng. */
export async function updateDonationCertificateEmailState(certificateId: string, emailKind: 'ISSUANCE' | 'REVOCATION', expectedStatus: DonationCertificateEmailStatus, nextStatus: DonationCertificateEmailStatus, patch: { attemptCount?: number; acceptedAt?: Date; providerMessageId?: string; lastErrorCode?: string }): Promise<DonationCertificateRecord | null> {
  const fieldName = emailKind === 'ISSUANCE' ? 'issuanceEmail' : 'revocationEmail';
  const setPatch: Record<string, unknown> = { [`${fieldName}.status`]: nextStatus };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) setPatch[`${fieldName}.${key}`] = value;
  return DonationCertificateMongoModel.findOneAndUpdate({ certificateId, [`${fieldName}.status`]: expectedStatus }, { $set: setPatch }, { new: true }).lean<DonationCertificateRecord>().exec();
}

/** Lấy bounded batch candidate cần kiểm tra finality hoặc delivery reconciliation. */
export async function findCertificatesNeedingReconciliation(now: Date, limit: number): Promise<DonationCertificateRecord[]> {
  return DonationCertificateMongoModel.find({ $or: [{ issuanceStatus: 'PENDING_FINALITY', nextFinalityCheckAt: { $lte: now } }, { issuanceStatus: 'ISSUED', 'issuanceEmail.status': { $in: ['NOT_QUEUED', 'RETRYING'] } }, { issuanceStatus: 'REVOKED', issuedAt: { $exists: true }, 'revocationEmail.status': { $in: ['NOT_QUEUED', 'RETRYING'] } }] }).sort({ nextFinalityCheckAt: 1 }).limit(limit).lean<DonationCertificateRecord[]>().exec();
}

/** Lấy certificate ISSUED còn trong cửa sổ reorg để đối chiếu canonical chain. */
export async function findIssuedCertificatesForReverification(currentBlockNumber: number, limit: number): Promise<DonationCertificateRecord[]> {
  return DonationCertificateMongoModel.find({ issuanceStatus: 'ISSUED', reverifyUntilBlock: { $gte: currentBlockNumber } }).sort({ reverifyUntilBlock: 1 }).limit(limit).lean<DonationCertificateRecord[]>().exec();
}

/** Cập nhật lần kiểm tra tiếp theo sau PENDING hoặc RPC tạm thời unavailable. */
export async function scheduleDonationCertificateFinalityCheck(certificateId: string, nextFinalityCheckAt: Date, errorCode?: string): Promise<void> {
  await DonationCertificateMongoModel.updateOne({ certificateId, issuanceStatus: 'PENDING_FINALITY' }, { $set: { nextFinalityCheckAt, ...(errorCode ? { lastErrorCode: errorCode } : {}) }, $inc: { finalityCheckCount: 1 } }).exec();
}

/** Đổi mode sang confirmation fallback đúng một lần khi provider xác nhận tag finalized không hỗ trợ. */
export async function switchDonationCertificateToConfirmationFallback(certificateId: string): Promise<DonationCertificateRecord | null> {
  return DonationCertificateMongoModel.findOneAndUpdate({ certificateId, issuanceStatus: 'PENDING_FINALITY', requestedFinalityMode: 'RPC_FINALIZED', allowConfirmationFallback: true }, { $set: { requestedFinalityMode: 'CONFIRMATION_FALLBACK', allowConfirmationFallback: false } }, { new: true }).lean<DonationCertificateRecord>().exec();
}

export type { DonationCertificateRecord, DonationCertificateSnapshot, DonationCertificateIssuanceStatus };
