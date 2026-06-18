import mongoose, { Schema } from 'mongoose';

export type DepositStatus = 'PENDING_PAYMENT' | 'PAYMENT_CONFIRMED' | 'MINT_COMPLETED' | 'FAILED';

export type DepositTransaction = {
  id: string;
  orderCode: string;
  userId: string;
  walletAddress: string;
  amountVnd: number;
  tokenAmount: number;
  paymentUrl: string;
  status: DepositStatus;
  onChainTransactionHash: string | null;
  payosTransactionId: string | null;
  failureReason: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  paymentConfirmedAt: Date | null;
  mintCompletedAt: Date | null;
  webhookProcessedAt: Date | null;
};

const depositTransactionSchema = new Schema<DepositTransaction>({
  id: { type: String, required: true, unique: true },
  orderCode: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  walletAddress: { type: String, required: true },
  amountVnd: { type: Number, required: true },
  tokenAmount: { type: Number, required: true },
  paymentUrl: { type: String, required: true },
  status: { type: String, required: true, index: true },
  onChainTransactionHash: { type: String, default: null },
  payosTransactionId: { type: String, default: null },
  failureReason: { type: String, default: null },
  correlationId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  paymentConfirmedAt: { type: Date, default: null },
  mintCompletedAt: { type: Date, default: null },
  webhookProcessedAt: { type: Date, default: null }
});

const DepositTransactionModel = mongoose.model<DepositTransaction>('DepositTransaction', depositTransactionSchema);
export { DepositTransactionModel };

/**
 * Hàm tạo mới giao dịch nạp tiền.
 * Mục đích: lưu trạng thái chờ thanh toán ngay sau khi tạo payment link.
 */
export async function createDepositTransaction(transaction: DepositTransaction): Promise<DepositTransaction> {
  const createdTransaction = await DepositTransactionModel.create(transaction);
  return createdTransaction.toObject() as DepositTransaction;
}

/**
 * Hàm tìm giao dịch theo orderCode.
 * Mục đích: tra cứu giao dịch phục vụ webhook và màn hình trạng thái.
 */
export async function findDepositTransactionByOrderCode(orderCode: string): Promise<DepositTransaction | null> {
  return DepositTransactionModel.findOne({ orderCode }).lean<DepositTransaction>().exec();
}

/**
 * Hàm lấy danh sách giao dịch nạp tiền gần nhất theo người dùng.
 * Mục đích: cung cấp dữ liệu lịch sử cho sidebar trang deposit.
 */
export async function listRecentDepositTransactionsByUserId(
  userId: string,
  limit: number
): Promise<DepositTransaction[]> {
  return DepositTransactionModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<DepositTransaction[]>()
    .exec();
}

/**
 * Hàm lấy danh sách giao dịch nạp tiền thất bại mới nhất.
 * Mục đích: cung cấp dữ liệu nguồn cho bảng log lỗi hệ thống của Admin.
 */
export async function findLatestFailedDepositTransactions(limitCount: number): Promise<DepositTransaction[]> {
  const normalizedLimitCount = Number.isFinite(limitCount)
    ? Math.max(1, Math.min(200, Math.floor(limitCount)))
    : 50;

  return DepositTransactionModel.find({ status: 'FAILED' })
    .sort({ updatedAt: -1 })
    .limit(normalizedLimitCount)
    .lean<DepositTransaction[]>()
    .exec();
}

/**
 * Hàm tính tổng token đã mint thành công theo người dùng.
 * Mục đích: cung cấp số dư token quy đổi từ luồng deposit cho sidebar.
 */
export async function calculateMintCompletedTokenBalanceByUserId(userId: string): Promise<number> {
  const aggregateResult = await DepositTransactionModel.aggregate<{ totalTokenBalance: number }>([
    {
      $match: {
        userId,
        status: 'MINT_COMPLETED'
      }
    },
    {
      $group: {
        _id: null,
        totalTokenBalance: { $sum: '$tokenAmount' }
      }
    }
  ]);

  if (aggregateResult.length === 0) {
    return 0;
  }

  return Number(aggregateResult[0].totalTokenBalance || 0);
}

/**
 * Hàm cập nhật giao dịch nạp tiền.
 * Mục đích: đồng bộ trạng thái thanh toán và trạng thái mint on-chain.
 */
export async function updateDepositTransaction(transaction: DepositTransaction): Promise<DepositTransaction> {
  const updatedTransaction = await DepositTransactionModel.findOneAndUpdate(
    { id: transaction.id },
    transaction,
    { returnDocument: 'after' }
  ).exec();

  return (updatedTransaction?.toObject() as DepositTransaction) || transaction;
}
