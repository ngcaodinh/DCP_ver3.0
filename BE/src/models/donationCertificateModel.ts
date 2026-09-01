import mongoose, { Schema } from 'mongoose';

export type DonationCertificateFinalityMode = 'RPC_FINALIZED' | 'CONFIRMATION_FALLBACK';
export type DonationCertificateIssuanceStatus = 'PENDING_FINALITY' | 'ISSUED' | 'REVOKED' | 'BLOCKED';
export type DonationCertificateEmailStatus = 'NOT_QUEUED' | 'QUEUED' | 'RETRYING' | 'SENT' | 'FAILED' | 'SKIPPED_UNVERIFIED_EMAIL';
export type PublicCertificateVerificationStatus = 'PENDING' | 'VERIFIED' | 'REVOKED' | 'UNAVAILABLE';

export interface DonationCertificatePublicResponse {
  certificateId: string; issuanceStatus: DonationCertificateIssuanceStatus; verificationStatus: PublicCertificateVerificationStatus;
  issuedAt: string | null; revokedAt: string | null; verificationCheckedAt: string; currentConfirmations: number | null; finalizedBlockNumber: number | null;
  certificate: { donorName: string; donorAddress: string; projectId: string; projectName: string; organizationName: string; amountRaw: string; tokenSymbol: 'DCT'; tokenDecimals: 0; vndEquivalent: string; valuationPolicy: 'POC_1_DCT_EQUALS_1_VND'; donatedAt: string } | null;
  chain: { chainId: number; networkName: string; contractAddress: string; transactionHash: string; blockNumber: number; blockHash: string; logIndex: number; finalityMode: DonationCertificateFinalityMode; confirmationsAtIssue: number; explorerUrl: string } | null;
  verificationUrl: string; pdfUrl: string | null;
}

export interface DonationCertificateEmailDeliveryRecord {
  status: DonationCertificateEmailStatus;
  attemptCount: number;
  acceptedAt?: Date;
  providerMessageId?: string;
  lastErrorCode?: string;
}

export interface DonationCertificateSnapshot {
  donorName: string; donorAddress: string; projectId: string; projectName: string; organizationName: string;
  amountRaw: string; tokenSymbol: 'DCT'; tokenDecimals: 0; vndEquivalent: string; valuationPolicy: 'POC_1_DCT_EQUALS_1_VND';
  donatedAt: Date; chainId: number; networkName: string; contractAddress: string; transactionHash: string;
  blockNumber: number; blockHash: string; logIndex: number; finalityMode: DonationCertificateFinalityMode; confirmationsAtIssue: number;
}

export interface DonationCertificateRecord {
  certificateId: string; schemaVersion: 1; chainId: number; transactionHash: string; donorUserId: string;
  expectedProjectId: string; expectedDonorAddress: string; expectedAmountRaw: string; expectedIsAnonymous: false;
  firstObservedAt: Date; issuanceStatus: DonationCertificateIssuanceStatus; issuanceEmail: DonationCertificateEmailDeliveryRecord;
  revocationEmail: DonationCertificateEmailDeliveryRecord; requestedFinalityMode: DonationCertificateFinalityMode;
  allowConfirmationFallback: boolean; finalityCheckCount: number; nextFinalityCheckAt: Date; snapshot?: DonationCertificateSnapshot;
  issuedAt?: Date; blockedAt?: Date; revokedAt?: Date;
  revocationReasonCode?: 'RECEIPT_MISSING' | 'RECEIPT_FAILED' | 'BLOCK_HASH_MISMATCH' | 'EVENT_MISMATCH';
  blockedReasonCode?: 'USER_NOT_FOUND' | 'PROJECT_NOT_FOUND' | 'ORGANIZATION_NOT_FOUND' | 'INVALID_CONFIGURATION';
  lastErrorCode?: string; lastVerificationAt?: Date; reverifyUntilBlock?: number; reverificationCompletedAt?: Date; createdAt: Date; updatedAt: Date;
}

const deliverySchema = new Schema<DonationCertificateEmailDeliveryRecord>({ status: { type: String, required: true }, attemptCount: { type: Number, required: true }, acceptedAt: Date, providerMessageId: String, lastErrorCode: String }, { _id: false });
const snapshotSchema = new Schema<DonationCertificateSnapshot>({ donorName: String, donorAddress: String, projectId: String, projectName: String, organizationName: String, amountRaw: String, tokenSymbol: String, tokenDecimals: Number, vndEquivalent: String, valuationPolicy: String, donatedAt: Date, chainId: Number, networkName: String, contractAddress: String, transactionHash: String, blockNumber: Number, blockHash: String, logIndex: Number, finalityMode: String, confirmationsAtIssue: Number }, { _id: false });
const certificateSchema = new Schema<DonationCertificateRecord>({
  certificateId: { type: String, required: true }, schemaVersion: { type: Number, required: true }, chainId: { type: Number, required: true }, transactionHash: { type: String, required: true }, donorUserId: { type: String, required: true }, expectedProjectId: { type: String, required: true }, expectedDonorAddress: { type: String, required: true }, expectedAmountRaw: { type: String, required: true }, expectedIsAnonymous: { type: Boolean, required: true }, firstObservedAt: { type: Date, required: true }, issuanceStatus: { type: String, required: true }, issuanceEmail: { type: deliverySchema, required: true }, revocationEmail: { type: deliverySchema, required: true }, requestedFinalityMode: { type: String, required: true }, allowConfirmationFallback: { type: Boolean, required: true }, finalityCheckCount: { type: Number, required: true }, nextFinalityCheckAt: { type: Date, required: true }, snapshot: snapshotSchema, issuedAt: Date, blockedAt: Date, revokedAt: Date, revocationReasonCode: String, blockedReasonCode: String,
  lastErrorCode: String, lastVerificationAt: Date, reverifyUntilBlock: Number, reverificationCompletedAt: Date
}, { timestamps: true, versionKey: false });
certificateSchema.index({ chainId: 1, transactionHash: 1 }, { unique: true, name: 'uniq_chain_transaction' });
certificateSchema.index({ certificateId: 1 }, { unique: true, name: 'uniq_certificate_id' });
certificateSchema.index({ issuanceStatus: 1, nextFinalityCheckAt: 1 }, { name: 'certificate_finality_reconcile' });
certificateSchema.index({ issuanceStatus: 1, 'issuanceEmail.status': 1, issuedAt: 1 }, { name: 'certificate_issuance_email_reconcile' });
certificateSchema.index({ issuanceStatus: 1, 'revocationEmail.status': 1, revokedAt: 1 }, { name: 'certificate_revocation_email_reconcile' });
certificateSchema.index({ issuanceStatus: 1, reverifyUntilBlock: 1 }, { name: 'certificate_reverify' });
export const DonationCertificateMongoModel = mongoose.models.DonationCertificate || mongoose.model<DonationCertificateRecord>('DonationCertificate', certificateSchema);
