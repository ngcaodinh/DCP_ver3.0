/**
 * Schema cho collection guest_wallet_sessions — lưu trữ phiên guest wallet ẩn danh.
 * Mỗi phiên đại diện cho một ví không cần đăng nhập, được sponsor gas bởi Paymaster.
 * Timestamps được quản lý thủ công thay vì auto-timestamps để đảm bảo không bị
 * tự động override khi worker cập nhật trạng thái batch.
 */
import mongoose, { Schema } from 'mongoose';

export type GuestWalletSession = {
  sessionId: string;
  walletAddress: string;
  deviceFingerprintHash: string;
  ipAddress: string;
  userAgent: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  donationCount: number;
  totalDonatedAmount: number;
  totalSponsoredGas: number;
  renewalCount: number;
  claimedByUserId: string | null;
  serverSalt: string;
  /** Encrypted owner private key (AES-256-GCM với SMART_ACCOUNT_ENCRYPTION_KEY).
   * Được mã hóa từ raw owner key sau khi giải mã layer PBKDF2 từ FE.
   * Dùng cho backend relay donation (Cách 2). */
  smartAccountOwnerEncryptedPrivateKey: string | null;
  hasPendingDonation: boolean;
  pendingAlertSentAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const guestWalletSessionSchema = new Schema<GuestWalletSession>(
  {
    sessionId: { type: String, required: true, unique: true },
    walletAddress: { type: String, required: true },
    deviceFingerprintHash: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64,
      match: /^[0-9a-f]{64}$/
    },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true, maxlength: 512 },
    status: {
      type: String,
      required: true,
      enum: ['ACTIVE', 'EXPIRED', 'CLAIMED', 'PURGED'],
      default: 'ACTIVE'
    },
    donationCount: { type: Number, required: true, default: 0 },
    /** Tổng amount đã donate, đơn vị: 0.01 Token (ví dụ: 100 = 1 Token). Dùng integer để tránh floating point errors. */
    totalDonatedAmount: { type: Number, required: true, default: 0 },
    totalSponsoredGas: { type: Number, required: true, default: 0 },
    renewalCount: { type: Number, required: true, default: 0 },
    claimedByUserId: {
      type: String,
      default: null,
      validate: {
        validator: (v: string | null) => v === null || v.length > 0,
        message: 'claimedByUserId must be null or non-empty string'
      }
    },
    serverSalt: { type: String, required: true },
    smartAccountOwnerEncryptedPrivateKey: { type: String, default: null },
    hasPendingDonation: { type: Boolean, required: true, default: false },
    pendingAlertSentAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { timestamps: false }
);

guestWalletSessionSchema.index({ walletAddress: 1 });
guestWalletSessionSchema.index({ deviceFingerprintHash: 1 });
guestWalletSessionSchema.index({ ipAddress: 1, createdAt: 1 });
guestWalletSessionSchema.index({ status: 1, expiresAt: 1 });

export const GuestWalletSessionModel = mongoose.model<GuestWalletSession>(
  'GuestWalletSession',
  guestWalletSessionSchema
);
