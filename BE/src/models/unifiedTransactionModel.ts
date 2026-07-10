/**
 * Schema cho collection unified_transactions - lưu trữ các giao dịch minh bạch hợp nhất
 * từ nhiều nguồn: PayOS (nạp tiền, quyên góp), Blockchain (DonationReceived events),
 * và các trạng thái liên quan.
 *
 * Mục đích: phục vụ tầng Unified Transparency Layer (Lane D) - D1.
 *
 * Index strategy (thứ tự ưu tiên theo tần suất query):
 *  1. correlationId (unique) - JOIN PayOS <-> blockchain, idempotency
 *  2. (eventTimestamp, utxId) - keyset pagination global (không filter)
 *  3. (projectId, eventTimestamp, utxId) - keyset pagination theo dự án
 *  4. (walletAddress, eventTimestamp, utxId) - keyset pagination theo ví
 *  5. chainTxHash (sparse) - lookup theo tx hash trên blockchain
 *
 * Retention: 3 năm (theo QA Plan Section 6.4)
 */
import mongoose, { Schema } from 'mongoose';

/** Loại sự kiện trong unified timeline */
export type UnifiedEventType =
  | 'DEPOSIT'
  | 'DONATION'
  | 'DISBURSEMENT'
  | 'MINT';

/** Nguồn gốc của dữ liệu giao dịch */
export type UnifiedTransactionSource = 'PAYOS' | 'BLOCKCHAIN' | 'MIXED';

/** Trạng thái xác nhận trên blockchain */
export type UnifiedChainStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REORGED';

/** Trạng thái thanh toán PayOS */
export type UnifiedPayosStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'FAILED';

/**
 * Regex Ethereum transaction hash (0x + 64 hex chars).
 * Áp dụng ở schema validator để chặn giá trị sai format ở mọi đường insert.
 */
export const CHAIN_TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * Regex Ethereum wallet address (0x + 40 hex chars).
 * Áp dụng ở schema validator để chuẩn hóa địa chỉ ví ngay tại database boundary.
 */
export const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Hàm helper validate chainTxHash. Đặt trong module để cả schema
 * (mongoose validator) và repository đều sử dụng cùng một nguồn.
 * @param value Giá trị cần kiểm tra
 * @returns true nếu hợp lệ, false nếu không
 */
export function isValidChainTxHash(value: unknown): boolean {
  return typeof value === 'string' && CHAIN_TX_HASH_REGEX.test(value);
}

/** Bản ghi unified transaction - lưu trữ thông tin tổng hợp từ PayOS và blockchain */
export type UnifiedTransaction = {
  /** ID duy nhất của unified transaction record */
  utxId: string;
  /**
   * Correlation ID dùng để JOIN PayOS và blockchain events.
   * Format: "donation:${txHash}" hoặc "deposit:${orderCode}"
   */
  correlationId: string;
  /** ID dự án liên quan. Empty string ('') = deposit không gắn project cụ thể. */
  projectId: string;
  /** Địa chỉ ví của người dùng (donor) */
  walletAddress: string;
  /** Số tiền VND */
  amountVnd: number;
  /** Loại sự kiện */
  eventType: UnifiedEventType;
  /** Thời điểm sự kiện xảy ra */
  eventTimestamp: Date;
  /** Nguồn dữ liệu */
  source: UnifiedTransactionSource;
  /** Trạng thái trên blockchain */
  chainStatus: UnifiedChainStatus;
  /** Transaction hash trên blockchain (nếu có) */
  chainTxHash: string | null;
  /** Block number trên blockchain (nếu có) */
  chainBlockNumber: number | null;
  /** Trạng thái thanh toán PayOS (nếu có) */
  payosStatus: UnifiedPayosStatus | null;
  /** OrderCode PayOS (nếu có) */
  payosOrderCode: string | null;
  /** PayOS transaction ID (nếu có) */
  payosTransactionId: string | null;
  /** ID gốc từ PayOS (DepositTransaction.id hoặc GuestPayosDonation.id) */
  payosRecordId: string | null;
  /** ID gốc từ blockchain (Donation.transactionHash) */
  blockchainRecordId: string | null;
  /** Thời điểm tạo record trong collection */
  createdAt: Date;
  /** Thời điểm cập nhật record */
  updatedAt: Date;
};

const unifiedTransactionSchema = new Schema<UnifiedTransaction>(
  {
    utxId: { type: String, required: true, unique: true },
    correlationId: { type: String, required: true },
    projectId: {
      type: String,
      required: true,
      index: true,
      // F4 fix: cho phép null/undefined rỗng (deposit không gắn với project cụ thể).
      // Mongoose `required: true` chấp nhận giá trị khác null/undefined.
      // Giá trị empty string '' được phép để tương thích ngược với data cũ.
      validate: {
        validator: (value: string) => typeof value === 'string' && value.length >= 0,
        message: 'projectId phải là string (cho phép empty cho deposit legacy)'
      }
    },
    walletAddress: {
      type: String,
      required: true,
      // Đảm bảo mọi wallet insert vào database đều có format EIP-55 hợp lệ
      validate: {
        validator: (value: string) => WALLET_ADDRESS_REGEX.test(value),
        message: 'walletAddress phải có định dạng 0x + 40 hex chars'
      }
    },
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
    chainTxHash: {
      type: String,
      default: null,
      // F7 fix: validator áp dụng ở schema boundary, không phụ thuộc vào call-site
      validate: {
        validator: function (this: unknown, value: unknown): boolean {
          // null cho phép (vì DEPOSIT record không có chain tx hash)
          if (value === null || value === undefined) return true;
          return isValidChainTxHash(value);
        },
        message: 'chainTxHash phải có định dạng 0x + 64 hex chars hoặc null'
      }
    },
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

// F3 fix: compound index cho keyset pagination theo eventTimestamp + utxId (toàn cục, không filter)
// Phục vụ sort ASC + tie-break theo utxId khi query không có projectId/walletAddress
// Tránh COLLSCAN + SORT in-memory trên các dataset lớn
unifiedTransactionSchema.index({ eventTimestamp: 1, utxId: 1 });

// F3 fix: compound index cho keyset pagination theo projectId + eventTimestamp + utxId
// Phục vụ findUnifiedTimeline với filter projectId (phổ biến nhất)
unifiedTransactionSchema.index({ projectId: 1, eventTimestamp: 1, utxId: 1 });

// F3 fix: compound index cho keyset pagination theo walletAddress + eventTimestamp + utxId
// Phục vụ findUnifiedTimeline với filter walletAddress
unifiedTransactionSchema.index({ walletAddress: 1, eventTimestamp: 1, utxId: 1 });

// Compound index cho query timeline: projectId + eventTimestamp (để sort và filter)
unifiedTransactionSchema.index({ projectId: 1, eventTimestamp: 1 });

// Compound index cho cursor-based pagination theo walletAddress
unifiedTransactionSchema.index({ walletAddress: 1, eventTimestamp: 1 });

// Index cho chainTxHash để tra cứu nhanh theo transaction hash
unifiedTransactionSchema.index({ chainTxHash: 1 }, { sparse: true });

// Unique index trên correlationId để đảm bảo không có trùng
unifiedTransactionSchema.index({ correlationId: 1 }, { unique: true });

export const UnifiedTransactionModel = mongoose.model<UnifiedTransaction>(
  'UnifiedTransaction',
  unifiedTransactionSchema
);
