import { Job } from 'bull';
import crypto from 'node:crypto';
import { getLogger } from '../config/logger';
import {
  claimAuditorPayoutForTransfer,
  findAuditorPayoutById,
  findPendingAuditorPayouts,
  rotateAuditorPayoutTransferIdempotencyKey,
  updateAuditorPayout,
  type AuditorPayout
} from '../models/auditorPayoutModel';
import {
  findStaleAuditorStakeGuards,
  releaseAuditorWalletLock,
  type AuditorWalletLock
} from '../models/auditorStakeGuardModel';
import { AUDITOR_STAKE_GUARD_STALE_LOCK_MS } from '../constants/auditorStaking';
import {
  AUDITOR_PAYOUT_RETRY_DELAYS_MS,
  enqueueAuditorPayout,
  getAuditorPayoutQueue,
  type AuditorPayoutJobData
} from '../queues/auditorPayoutQueue';
import { finalizeAuditorPayoutAfterPayosSuccess, hasAuditorPayoutBalance } from '../services/auditorPayoutService';
import { createPayosTransfer, getPayosTransferStatusByReferenceId, type CreatePayosTransferResult } from '../services/payosService';

const logger = getLogger();
const MAX_AUDITOR_PAYOUT_ATTEMPTS = 4;
const MAX_PAYOS_POLL_ATTEMPTS = 60;
const PAYOS_POLL_DELAY_MS = 15_000;
const PENDING_PAYOUT_RECOVERY_INTERVAL_MS = 60_000;
let started = false;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/** Enqueue lại các payout PENDING sau restart để một lần lỗi Redis không làm mất lệnh chi trả. */
async function recoverPendingAuditorPayouts(): Promise<void> {
  const payouts = await findPendingAuditorPayouts(100);
  if (payouts.length === 0) return;
  await Promise.all(payouts.map(payout => enqueueAuditorPayout(payout.payoutId)));
}

/** Dọn lock mồ côi có điều kiện; payout chưa có Withdrawn hash không được coi là tiền đang bay trên provider. */
async function sweepOrphanedAuditorWalletLocks(): Promise<void> {
  const guards = await findStaleAuditorStakeGuards(
    new Date(Date.now() - AUDITOR_STAKE_GUARD_STALE_LOCK_MS),
    100
  );

  for (const guard of guards) {
    if (!guard.lockRefId || guard.walletLock === 'DEBT_SETTLING') continue;
    if (guard.walletLock === 'UNSTAKING') {
      await releaseAuditorWalletLock(guard.auditorUserId, guard.lockRefId, 'UNSTAKING');
      continue;
    }

    const payout = await findAuditorPayoutById(guard.lockRefId);
    const isInFlight = Boolean(payout?.onchainTxHash && payout.status !== 'BURNED' && payout.status !== 'CANCELLED');
    if (isInFlight) continue;
    if (payout?.status === 'PENDING' && !payout.onchainTxHash) {
      await updateAuditorPayout(payout.payoutId, {
        status: 'MANUAL_REVIEW',
        errorMessage: 'Missing Withdrawn transaction hash while the wallet is locked; manual reconciliation is required before release.'
      });
      logger.error('Giữ wallet lock Auditor vì chưa xác định được trạng thái withdrawal.', {
        auditorUserId: guard.auditorUserId,
        payoutId: payout.payoutId
      });
      continue;
    }
    await releaseAuditorWalletLock(guard.auditorUserId, guard.lockRefId, guard.walletLock as AuditorWalletLock);
    logger.warn('Đã giải phóng wallet lock Auditor mồ côi.', { auditorUserId: guard.auditorUserId, lockRefId: guard.lockRefId });
  }
}

/** Chuẩn hóa lỗi ngoài luồng để log trạng thái payout không chứa object provider thô. */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chuyển lỗi PayOS đã xác nhận FAILED sang retry mới; chỉ trạng thái đã biết an toàn mới được mở khóa DCT. */
async function scheduleVerifiedFailure(payoutId: string, completedAttempt: number, errorMessage: string): Promise<void> {
  if (completedAttempt >= MAX_AUDITOR_PAYOUT_ATTEMPTS) {
    await updateAuditorPayout(payoutId, { status: 'MANUAL_REVIEW', errorMessage });
    return;
  }
  await rotateAuditorPayoutTransferIdempotencyKey(
    payoutId,
    `auditor-payout:${payoutId}:${crypto.randomUUID()}`
  );
  await updateAuditorPayout(payoutId, { status: 'FAILED', errorMessage });
  await enqueueAuditorPayout(payoutId, completedAttempt + 1, {
    delay: AUDITOR_PAYOUT_RETRY_DELAYS_MS[completedAttempt - 1] ?? AUDITOR_PAYOUT_RETRY_DELAYS_MS.at(-1)
  });
}

/** Giữ lock TRANSFERRING khi không biết provider đã nhận lệnh hay chưa, rồi retry cùng idempotency key. */
async function scheduleUncertainProviderRetry(payoutId: string, completedAttempt: number, errorMessage: string): Promise<void> {
  if (completedAttempt >= MAX_AUDITOR_PAYOUT_ATTEMPTS) {
    await updateAuditorPayout(payoutId, { status: 'MANUAL_REVIEW', errorMessage });
    return;
  }
  await updateAuditorPayout(payoutId, { status: 'TRANSFERRING', errorMessage });
  await enqueueAuditorPayout(payoutId, completedAttempt + 1, {
    delay: AUDITOR_PAYOUT_RETRY_DELAYS_MS[completedAttempt - 1] ?? AUDITOR_PAYOUT_RETRY_DELAYS_MS.at(-1)
  });
}

/** Lên lịch poll bền vững qua Bull thay vì phụ thuộc webhook PayOS hoặc timer trong process hiện tại. */
async function schedulePayosPoll(payoutId: string, attemptNumber: number, pollAttempt: number): Promise<void> {
  if (pollAttempt >= MAX_PAYOS_POLL_ATTEMPTS) {
    await updateAuditorPayout(payoutId, {
      status: 'MANUAL_REVIEW',
      errorMessage: 'PayOS quá thời gian xác nhận giao dịch chi trả.'
    });
    return;
  }
  await enqueueAuditorPayout(payoutId, attemptNumber, {
    delay: PAYOS_POLL_DELAY_MS,
    pollAttempt: pollAttempt + 1
  });
}

/** Gọi PayOS theo snapshot đã đóng băng và chỉ sau khi kiểm tra DCT gộp vẫn nằm trong ví Auditor. */
async function createTransferForPayout(
  payout: AuditorPayout,
  idempotencyKey: string
): Promise<CreatePayosTransferResult> {
  return createPayosTransfer({
    requestId: payout.payoutId,
    amountVnd: payout.netAmountVnd,
    bankCode: payout.bankSnapshot.bankCode,
    bankAccountNumber: payout.bankSnapshot.bankAccountNumber,
    accountHolderName: payout.bankSnapshot.accountHolderName,
    description: `${payout.payoutType}-${payout.payoutId}`,
    idempotencyKey
  });
}

/** Áp dụng trạng thái PayOS, đảm bảo SUCCESS chỉ dẫn đến một lần burn bằng claim ở payout service. */
async function handleTransferResult(
  payout: AuditorPayout,
  transfer: CreatePayosTransferResult,
  attemptNumber: number,
  pollAttempt: number
): Promise<void> {
  await updateAuditorPayout(payout.payoutId, { payosTransferId: transfer.transferId, errorMessage: null });
  if (transfer.transferStatus === 'SUCCESS') {
    await finalizeAuditorPayoutAfterPayosSuccess(payout.payoutId);
    return;
  }
  if (transfer.transferStatus === 'FAILED') {
    await scheduleVerifiedFailure(payout.payoutId, attemptNumber, 'PayOS từ chối giao dịch chi trả.');
    return;
  }
  await schedulePayosPoll(payout.payoutId, attemptNumber, pollAttempt);
}

/** Xử lý job payout theo state machine: PENDING/FAILED tạo transfer, TRANSFERRING chỉ resolve cùng idempotency chain. */
async function processAuditorPayout(job: Job<AuditorPayoutJobData>): Promise<void> {
  const { payoutId, attemptNumber, pollAttempt } = job.data;
  const existingPayout = await findAuditorPayoutById(payoutId);
  if (!existingPayout || existingPayout.status === 'BURNED' || existingPayout.status === 'MANUAL_REVIEW') return;

  if (existingPayout.status === 'TRANSFERRING') {
    if (!existingPayout.payosTransferId) {
      try {
        if (!await hasAuditorPayoutBalance(existingPayout)) {
          await updateAuditorPayout(payoutId, { status: 'MANUAL_REVIEW', errorMessage: 'Số dư DCT không đủ trước khi gửi lệnh PayOS.' });
          return;
        }
        const transfer = await createTransferForPayout(existingPayout, existingPayout.transferIdempotencyKey);
        await handleTransferResult(existingPayout, transfer, attemptNumber, pollAttempt);
      } catch (error) {
        await scheduleUncertainProviderRetry(payoutId, attemptNumber, getErrorMessage(error));
      }
      return;
    }
    try {
      const status = await getPayosTransferStatusByReferenceId(payoutId);
      if (status.found && status.transferStatus === 'SUCCESS') {
        await finalizeAuditorPayoutAfterPayosSuccess(payoutId);
      } else if (status.found && status.transferStatus === 'FAILED') {
        await scheduleVerifiedFailure(payoutId, attemptNumber, status.errorMessage || 'PayOS từ chối giao dịch chi trả.');
      } else {
        await schedulePayosPoll(payoutId, attemptNumber, pollAttempt);
      }
    } catch (error) {
      await schedulePayosPoll(payoutId, attemptNumber, pollAttempt);
      logger.warn('Không thể poll PayOS payout; giữ lock DCT và sẽ poll lại.', { payoutId, errorMessage: getErrorMessage(error) });
    }
    return;
  }

  const payout = await claimAuditorPayoutForTransfer(payoutId, attemptNumber);
  if (!payout) return;
  try {
    if (!await hasAuditorPayoutBalance(payout)) {
      await updateAuditorPayout(payoutId, { status: 'MANUAL_REVIEW', errorMessage: 'Số dư DCT không đủ trước khi gửi lệnh PayOS.' });
      return;
    }
    const transfer = await createTransferForPayout(payout, payout.transferIdempotencyKey);
    await handleTransferResult(payout, transfer, attemptNumber, pollAttempt);
  } catch (error) {
    await scheduleUncertainProviderRetry(payoutId, attemptNumber, getErrorMessage(error));
  }
}

/** Khởi động worker Bull riêng cho payout Auditor để không lẫn trạng thái với giải ngân tổ chức. */
export function startAuditorPayoutWorker(): void {
  if (started) return;
  const queue = getAuditorPayoutQueue();
  if (!queue) return;
  queue.process(3, processAuditorPayout);
  started = true;
  void recoverPendingAuditorPayouts().catch(error => {
    logger.warn('Không thể phục hồi payout Auditor đang chờ.', { errorMessage: getErrorMessage(error) });
  });
  recoveryTimer = setInterval(() => {
    void recoverPendingAuditorPayouts().catch(error => {
      logger.warn('Không thể phục hồi payout Auditor đang chờ.', { errorMessage: getErrorMessage(error) });
    });
    void sweepOrphanedAuditorWalletLocks().catch(error => {
      logger.warn('Không thể dọn wallet lock Auditor mồ côi.', { errorMessage: getErrorMessage(error) });
    });
  }, PENDING_PAYOUT_RECOVERY_INTERVAL_MS);
  void sweepOrphanedAuditorWalletLocks().catch(error => {
    logger.warn('Không thể dọn wallet lock Auditor mồ côi.', { errorMessage: getErrorMessage(error) });
  });
}

/** Dừng queue payout theo graceful shutdown để không cắt ngang job đang gọi PayOS. */
export async function stopAuditorPayoutWorker(): Promise<void> {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  const queue = getAuditorPayoutQueue();
  if (queue && started) await queue.close();
  started = false;
}

/** Reset state module chỉ dành cho test isolated. */
export function __resetAuditorPayoutWorkerState(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  started = false;
}

/** Test hook for the stale-lock crash window; it must not be called by runtime code. */
export const __auditorPayoutWorkerTestHooks = { sweepOrphanedAuditorWalletLocks };
