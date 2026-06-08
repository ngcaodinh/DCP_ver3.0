/**
 * Schema cho collection guest_deposits — lưu trữ trạng thái nạp tiền PayOS cho guest donation.
 * Mỗi record đại diện cho một giao dịch nạp tiền chờ thanh toán hoặc đã hoàn tất.
 * Sau khi thanh toán thành công, backend mint token và tự động thực hiện donation on-chain.
 */
import mongoose, { Schema } from 'mongoose';

export type GuestDepositStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'MINTING'
  | 'DONATION_EXECUTING'
  | 'DONATION_COMPLETED'
  | 'DONATION_FAILED'
  | 'FAILED';

export type GuestDepositTransaction = {
  id: string;
  orderCode: string;
  guestSessionId: string;
  walletAddress: string;
  projectId: string;
  amount: number;
  amountVnd: number;
  paymentUrl: string;
  returnUrl: string;
  status: GuestDepositStatus;
  mintTxHash: string | null;
  userOpHash: string | null;
  donationTxHash: string | null;
  errorMessage: string | null;
  payosTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  webhookProcessedAt: Date | null;
};

const guestDepositTransactionSchema = new Schema<GuestDepositTransaction>(
  {
    id: { type: String, required: true, unique: true },
    orderCode: { type: String, required: true, unique: true },
    guestSessionId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true },
    projectId: { type: String, required: true },
    amount: { type: Number, required: true },
    amountVnd: { type: Number, required: true },
    paymentUrl: { type: String, required: true },
    returnUrl: { type: String, required: true },
    status: { type: String, required: true, index: true },
    mintTxHash: { type: String, default: null },
    userOpHash: { type: String, default: null },
    donationTxHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
    payosTransactionId: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    webhookProcessedAt: { type: Date, default: null }
  },
  { timestamps: false }
);

guestDepositTransactionSchema.index({ orderCode: 1 }, { unique: true });
guestDepositTransactionSchema.index({ guestSessionId: 1 });
guestDepositTransactionSchema.index({ status: 1 });
guestDepositTransactionSchema.index({ walletAddress: 1 });
guestDepositTransactionSchema.index({ createdAt: -1 });

export const GuestDepositTransactionModel = mongoose.model<GuestDepositTransaction>(
  'GuestDepositTransaction',
  guestDepositTransactionSchema
);

/**
 * Hàm tạo mới guest deposit transaction.
 * Mục đích: lưu trạng thái chờ thanh toán ngay sau khi tạo payment link.
 */
export async function createGuestDepositTransaction(
  transaction: GuestDepositTransaction
): Promise<GuestDepositTransaction> {
  const createdTransaction = await GuestDepositTransactionModel.create(transaction);
  return createdTransaction.toObject() as GuestDepositTransaction;
}

/**
 * Hàm tìm guest deposit transaction theo orderCode.
 * Mục đích: tra cứu giao dịch phục vụ webhook và poll status.
 */
export async function findGuestDepositByOrderCode(
  orderCode: string
): Promise<GuestDepositTransaction | null> {
  return GuestDepositTransactionModel.findOne({ orderCode })
    .lean<GuestDepositTransaction>()
    .exec();
}

/**
 * Hàm tìm guest deposit transaction mới nhất theo guestSessionId.
 * Mục đích: poll status khi orderCode không có trên URL (edge case).
 */
export async function findLatestGuestDepositBySession(
  guestSessionId: string
): Promise<GuestDepositTransaction | null> {
  return GuestDepositTransactionModel.findOne({ guestSessionId })
    .sort({ createdAt: -1 })
    .lean<GuestDepositTransaction>()
    .exec();
}

/**
 * Hàm cập nhật guest deposit transaction.
 * Mục đích: đồng bộ trạng thái thanh toán, mint, và donation sau mỗi bước xử lý.
 */
export async function updateGuestDepositTransaction(
  transaction: Partial<GuestDepositTransaction> & { orderCode: string }
): Promise<GuestDepositTransaction | null> {
  const updatedTransaction = await GuestDepositTransactionModel.findOneAndUpdate(
    { orderCode: transaction.orderCode },
    {
      ...transaction,
      updatedAt: new Date()
    },
    { returnDocument: 'after' }
  )
    .lean<GuestDepositTransaction>()
    .exec();
  return updatedTransaction ?? null;
}
