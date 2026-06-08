/**
 * Repository cho guest deposit transactions.
 * Cung cấp các thao tác CRUD trên collection guest_deposits.
 */
import {
  GuestDepositTransaction,
  createGuestDepositTransaction,
  findGuestDepositByOrderCode,
  findLatestGuestDepositBySession,
  updateGuestDepositTransaction,
  GuestDepositTransactionModel
} from '../models/guestDepositModel';

/**
 * Hàm tạo mới guest deposit transaction.
 */
export async function createGuestDeposit(
  transaction: GuestDepositTransaction
): Promise<GuestDepositTransaction> {
  return createGuestDepositTransaction(transaction);
}

/**
 * Hàm tìm guest deposit transaction theo orderCode.
 */
export async function findGuestDepositByOrderCodeRepo(
  orderCode: string
): Promise<GuestDepositTransaction | null> {
  return findGuestDepositByOrderCode(orderCode);
}

/**
 * Hàm tìm guest deposit transaction mới nhất theo guestSessionId.
 */
export async function findLatestGuestDepositBySessionRepo(
  guestSessionId: string
): Promise<GuestDepositTransaction | null> {
  return findLatestGuestDepositBySession(guestSessionId);
}

/**
 * Hàm cập nhật trạng thái guest deposit transaction.
 */
export async function updateGuestDepositStatus(
  orderCode: string,
  updateData: Partial<GuestDepositTransaction>
): Promise<GuestDepositTransaction | null> {
  return updateGuestDepositTransaction({ orderCode, ...updateData });
}

/**
 * Hàm đếm tổng số guest deposit transaction theo session.
 */
export async function countGuestDepositsBySession(
  guestSessionId: string
): Promise<number> {
  return GuestDepositTransactionModel.countDocuments({ guestSessionId }).exec();
}
