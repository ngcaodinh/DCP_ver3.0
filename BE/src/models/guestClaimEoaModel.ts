/**
 * Schema cho collection guest_claim_eoas — lưu trữ claim EOA tạm thời cho Keyless Claim flow.
 * Mỗi record đại diện cho một ephemeral EOA được sinh khi user bắt đầu claim process.
 * Private key được mã hóa AES-256-GCM, chỉ server giữ encrypted version.
 * Record có TTL 10 phút, tự động hết hạn sau khi claim hoặc hết thời gian.
 */
import mongoose, { Schema } from 'mongoose';

export type GuestClaimEoa = {
  sessionId: string;
  /** Nonce độc lập (UUID) — dùng làm idempotency key giữa prepare và execute. */
  claimNonce: string;
  /** Địa chỉ ephemeral EOA được tạo trong prepare step — dùng làm target cho Kernel.changeOwner(). */
  claimEoaAddress: string;
  claimedByUserId: string;
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const guestClaimEoaSchema = new Schema<GuestClaimEoa>(
  {
    sessionId: { type: String, required: true, unique: true },
    /** Nonce độc lập (UUID) — dùng làm idempotency key giữa prepare và execute. */
    claimNonce: { type: String, required: true },
    claimEoaAddress: { type: String, required: true },
    claimedByUserId: { type: String, required: true },
    /** AES-256-GCM encrypted private key — dạng hex string. */
    encryptedPrivateKey: { type: String, required: true },
    /** Initialization vector 12 bytes cho AES-256-GCM — dạng hex string. */
    iv: { type: String, required: true },
    /** GCM authentication tag 16 bytes — dạng hex string. */
    authTag: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

guestClaimEoaSchema.index({ claimNonce: 1 }, { unique: true });
guestClaimEoaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
guestClaimEoaSchema.index({ claimedByUserId: 1 });

export const GuestClaimEoaModel = mongoose.model<GuestClaimEoa>(
  'GuestClaimEoa',
  guestClaimEoaSchema
);
