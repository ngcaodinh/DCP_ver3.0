/**
 * Schema cho collection anonymous_donation_audits — lưu trữ audit trail cho
 * mọi donation ẩn danh. Mỗi record ghi nhận đầy đủ context để phục vụ
 * risk scoring, QF weighting, và compliance audit.
 */
import mongoose, { Schema } from 'mongoose';

export type AnonymousDonationAudit = {
  auditId: string;
  sessionId: string;
  walletAddress: string;
  projectId: string;
  amount: number;
  trustMultiplier: number;
  riskScore: number;
  userOpHash: string;
  onChainTxHash: string | null;
  onChainBlockNumber: number | null;
  paymasterSponsoredGas: boolean;
  claimedByUserId: string | null;
  isAnonymous: boolean;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  indexedAt: Date | null;
};

const anonymousDonationAuditSchema = new Schema<AnonymousDonationAudit>(
  {
    auditId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    walletAddress: { type: String, required: true },
    projectId: { type: String, required: true },
    amount: { type: Number, required: true },
    trustMultiplier: { type: Number, required: true, default: 1.0 },
    riskScore: { type: Number, required: true, default: 0 },
    userOpHash: { type: String, required: true, unique: true },
    onChainTxHash: { type: String, default: null },
    onChainBlockNumber: { type: Number, default: null },
    paymasterSponsoredGas: { type: Boolean, required: true, default: true },
    claimedByUserId: { type: String, default: null },
    isAnonymous: { type: Boolean, required: true, default: true },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true, maxlength: 512 },
    createdAt: { type: Date, required: true },
    indexedAt: { type: Date, default: null }
  },
  { timestamps: false }
);

anonymousDonationAuditSchema.index({ sessionId: 1 });
anonymousDonationAuditSchema.index({ walletAddress: 1 });
anonymousDonationAuditSchema.index({ projectId: 1 });
anonymousDonationAuditSchema.index({ claimedByUserId: 1 });
anonymousDonationAuditSchema.index({ createdAt: 1 });
/** Index cho reverse lookup khi sync worker có transactionHash nhưng không có userOpHash. */
anonymousDonationAuditSchema.index({ onChainTxHash: 1 });

export const AnonymousDonationAuditModel = mongoose.model<AnonymousDonationAudit>(
  'AnonymousDonationAudit',
  anonymousDonationAuditSchema
);
