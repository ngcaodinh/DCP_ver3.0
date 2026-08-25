import crypto from 'node:crypto';
import { getLogger } from '../config/logger';
import { findAuditorPayoutAccountByUserId } from '../models/auditorPayoutAccountModel';
import {
  createAuditorPayout,
  findAuditorPayoutById,
  findAuditorPayoutBySource,
  linkAuditorPayoutToOnchainWithdrawal,
  type AuditorPayout
} from '../models/auditorPayoutModel';
import { promoteAuditorWithdrawalLockToPayout } from '../models/auditorStakeGuardModel';
import { enqueueAuditorPayout } from '../queues/auditorPayoutQueue';
import { ApplicationError } from '../utils/applicationError';
import { getAuditorPayoutFeeVnd } from '../constants/auditorStaking';

const logger = getLogger();

/**
 * Chuẩn bị payout rút cọc trước UserOperation để lock ví tồn tại trước khi DCT rời contract.
 * Payout chỉ được enqueue sau khi txHash Withdrawn đã được gắn và không bao giờ dùng dữ liệu tài khoản mới hơn snapshot.
 */
export async function createStakeWithdrawalPayout(input: {
  auditorUserId: string;
  payoutId?: string;
  sourceRefId?: string;
  onchainTxHash: string | null;
  amount: bigint;
}): Promise<AuditorPayout> {
  if (input.amount <= 0n) {
    throw new ApplicationError('Khoản rút cọc không hợp lệ.', 409, 'CONFLICT');
  }
  if (input.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApplicationError('Khoản rút vượt giới hạn chi trả tự động; hệ thống sẽ cần xử lý thủ công.', 409, 'CONFLICT');
  }

  const payoutId = input.payoutId ?? crypto.randomUUID();
  const sourceRefId = input.sourceRefId ?? input.onchainTxHash ?? payoutId;
  const existing = await findAuditorPayoutBySource('STAKE_WITHDRAWAL', sourceRefId);
  if (existing) return existing;

  const payoutAccount = await findAuditorPayoutAccountByUserId(input.auditorUserId);
  if (!payoutAccount) {
    throw new ApplicationError('Không tìm thấy tài khoản ngân hàng nhận khoản rút cọc.', 409, 'CONFLICT');
  }
  const amountVnd = Number(input.amount);
  const feeVnd = getAuditorPayoutFeeVnd();
  const netAmountVnd = amountVnd - feeVnd;
  if (netAmountVnd <= 0) {
    throw new ApplicationError('Khoản rút cọc không đủ để thanh toán phí chuyển khoản.', 409, 'CONFLICT');
  }

  const now = new Date();
  let payout: AuditorPayout;
  try {
    payout = await createAuditorPayout({
      payoutId,
      auditorUserId: input.auditorUserId,
      payoutType: 'STAKE_WITHDRAWAL',
      sourceRefId,
      amountVnd,
      feeVnd,
      netAmountVnd,
      bankSnapshot: {
        bankName: payoutAccount.bankName,
        bankCode: payoutAccount.bankCode,
        bankAccountNumber: payoutAccount.bankAccountNumber,
        accountHolderName: payoutAccount.accountHolderName
      },
      status: 'PENDING',
      payosTransferId: null,
      transferIdempotencyKey: `auditor-payout:${payoutId}:${crypto.randomUUID()}`,
      onchainTxHash: input.onchainTxHash,
      burnTxHash: null,
      attemptNumber: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    });
  } catch (error) {
    const duplicate = await findAuditorPayoutBySource('STAKE_WITHDRAWAL', sourceRefId);
    if (duplicate) return duplicate;
    throw error;
  }

  if (payout.onchainTxHash) {
    const enqueued = await enqueueAuditorPayout(payout.payoutId);
    if (!enqueued) {
      logger.warn('Payout rút cọc đang chờ enqueue lại khi worker khởi động.', { payoutId: payout.payoutId });
    }
  }
  return payout;
}

/** Xác nhận Withdrawn event cho payout đã khóa ví trước đó rồi mới cho phép worker gọi PayOS. */
export async function confirmStakeWithdrawalPayout(
  auditorUserId: string,
  payoutId: string,
  onchainTxHash: string
): Promise<AuditorPayout | null> {
  const linkedPayout = await linkAuditorPayoutToOnchainWithdrawal(payoutId, onchainTxHash)
    ?? await findAuditorPayoutById(payoutId);
  if (!linkedPayout || linkedPayout.onchainTxHash !== onchainTxHash || linkedPayout.status === 'CANCELLED') {
    return null;
  }

  await promoteAuditorWithdrawalLockToPayout(auditorUserId, payoutId);
  const enqueued = await enqueueAuditorPayout(payoutId);
  if (!enqueued) {
    logger.warn('Payout đã xác nhận Withdrawn nhưng chưa enqueue được.', { payoutId, onchainTxHash });
  }
  return linkedPayout;
}
