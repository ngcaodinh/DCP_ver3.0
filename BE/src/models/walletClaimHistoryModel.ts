/**
 * Schema cho collection wallet_claim_histories — lưu trữ lịch sử claim
 * khi user đăng nhập và yêu cầu migrate ví guest thành tài khoản chính thức.
 * Record này là immutable audit log, không bao giờ được update sau khi tạo.
 */
import mongoose, { Schema } from 'mongoose';

export type ClaimType = 'NEW_ACCOUNT' | 'EXISTING_ACCOUNT' | 'PARTIAL_CLAIM';

export type WalletClaimHistory = {
  claimId: string;
  sessionId: string;
  guestWalletAddress: string;
  claimedByUserId: string;
  claimType: ClaimType;
  keyMigrated: boolean;
  donationsMerged: boolean;
  changeOwnerTxHash: string;
  ipAddress: string;
  userAgent: string;
  claimedAt: Date;
  createdAt: Date;
};

const walletClaimHistorySchema = new Schema<WalletClaimHistory>(
  {
    claimId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    guestWalletAddress: { type: String, required: true },
    claimedByUserId: { type: String, required: true },
    claimType: {
      type: String,
      required: true,
      enum: ['NEW_ACCOUNT', 'EXISTING_ACCOUNT', 'PARTIAL_CLAIM']
    },
    keyMigrated: { type: Boolean, required: true, default: false },
    donationsMerged: { type: Boolean, required: true, default: false },
    changeOwnerTxHash: { type: String, required: true, default: '' },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true },
    claimedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true }
  },
  { timestamps: false }
);

walletClaimHistorySchema.index({ sessionId: 1 });
walletClaimHistorySchema.index({ guestWalletAddress: 1 });
walletClaimHistorySchema.index({ claimedByUserId: 1 });
walletClaimHistorySchema.index({ claimedAt: 1 });

export const WalletClaimHistoryModel = mongoose.model<WalletClaimHistory>(
  'WalletClaimHistory',
  walletClaimHistorySchema
);
