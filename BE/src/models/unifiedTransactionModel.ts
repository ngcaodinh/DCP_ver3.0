/**
 * Schema cho collection unified_transactions - luu tru cac giao dich minh bach hop nhat
 * tu nhieu nguon: PayOS (nap tien, quyen gop), Blockchain (DonationReceived events),
 * va cac trang thai lien quan.
 *
 * Muc dich: phuc vu tang Unified Transparency Layer (Lane D) - D1.
 * Index strategy: correlationId (unique), projectId+eventTimestamp, walletAddress, chainTxHash
 * Retention: 3 nam (theo QA Plan Section 6.4)
 */
import mongoose, { Schema } from 'mongoose';

/** Loai su kien trong unified timeline */
export type UnifiedEventType =
  | 'DEPOSIT'
  | 'DONATION'
  | 'DISBURSEMENT'
  | 'MINT';

/** Nguon goc cua du lieu giao dich */
export type UnifiedTransactionSource = 'PAYOS' | 'BLOCKCHAIN' | 'MIXED';

/** Trang thai xac nhan tren blockchain */
export type UnifiedChainStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REORGED';

/** Trang thai thanh toan PayOS */
export type UnifiedPayosStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'FAILED';

/** Ban ghi unified transaction - luu tru thong tin tong hop tu PayOS va blockchain */
export type UnifiedTransaction = {
  /** ID duy nhat cua unified transaction record */
  utxId: string;
  /**
   * Correlation ID dung de JOIN PayOS va blockchain events.
   * Format: "donation:${txHash}" hoac "deposit:${orderCode}"
   */
  correlationId: string;
  /** ID du an lien quan */
  projectId: string;
  /** Dia chi vi cua nguoi dung (donor) */
  walletAddress: string;
  /** So tien VND */
  amountVnd: number;
  /** Loai su kien */
  eventType: UnifiedEventType;
  /** Thoi diem su kien xay ra */
  eventTimestamp: Date;
  /** Nguon du lieu */
  source: UnifiedTransactionSource;
  /** Trang thai tren blockchain */
  chainStatus: UnifiedChainStatus;
  /** Transaction hash tren blockchain (neu co) */
  chainTxHash: string | null;
  /** Block number tren blockchain (neu co) */
  chainBlockNumber: number | null;
  /** Trang thai thanh toan PayOS (neu co) */
  payosStatus: UnifiedPayosStatus | null;
  /** OrderCode PayOS (neu co) */
  payosOrderCode: string | null;
  /** PayOS transaction ID (neu co) */
  payosTransactionId: string | null;
  /** ID goc tu PayOS (DepositTransaction.id hoac GuestPayosDonation.id) */
  payosRecordId: string | null;
  /** ID goc tu blockchain (Donation.transactionHash) */
  blockchainRecordId: string | null;
  /** Thoi diem tao record trong collection */
  createdAt: Date;
  /** Thoi diem cap nhat record */
  updatedAt: Date;
};

const unifiedTransactionSchema = new Schema<UnifiedTransaction>(
  {
    utxId: { type: String, required: true, unique: true },
    correlationId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true },
    amountVnd: { type: Number, required: true },
    eventType: {
      type: String,
      required: true,
      enum: ['DEPOSIT', 'DONATION', 'DISBURSEMENT', 'MINT']
    },
    eventTimestamp: { type: Date, required: true, index: true },
    source: {
      type: String,
      required: true,
      enum: ['PAYOS', 'BLOCKCHAIN', 'MIXED']
    },
    chainStatus: {
      type: String,
      required: true,
      enum: ['PENDING', 'CONFIRMED', 'FAILED', 'REORGED'],
      default: 'PENDING'
    },
    chainTxHash: { type: String, default: null },
    chainBlockNumber: { type: Number, default: null },
    payosStatus: {
      type: String,
      enum: ['PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'FAILED', null],
      default: null
    },
    payosOrderCode: { type: String, default: null },
    payosTransactionId: { type: String, default: null },
    payosRecordId: { type: String, default: null },
    blockchainRecordId: { type: String, default: null }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

// Compound index cho query timeline: projectId + eventTimestamp (de sort va filter)
unifiedTransactionSchema.index({ projectId: 1, eventTimestamp: 1 });

// Compound index cho cursor-based pagination theo walletAddress
unifiedTransactionSchema.index({ walletAddress: 1, eventTimestamp: 1 });

// Index cho chainTxHash de tra cuu nhanh theo transaction hash
unifiedTransactionSchema.index({ chainTxHash: 1 }, { sparse: true });

// Unique index tren correlationId de dam bao khong co trung
unifiedTransactionSchema.index({ correlationId: 1 }, { unique: true });

export const UnifiedTransactionModel = mongoose.model<UnifiedTransaction>(
  'UnifiedTransaction',
  unifiedTransactionSchema
);
