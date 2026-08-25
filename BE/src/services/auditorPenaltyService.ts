import crypto from 'node:crypto';
import { getWritableAuditorStakingContract, getReadOnlyAuditorStakingContract } from '../config/auditorStakingContract';
import { findUserById } from '../models/authModel';
import {
  claimAuditorLedgerEntry,
  completeAuditorLedgerEntry,
  type AuditorPenaltyLedgerEntry
} from '../models/auditorPenaltyLedgerModel';
import { increaseAuditorPenaltyDebt, initializeAuditorStakeGuard } from '../models/auditorStakeGuardModel';
import { ApplicationError } from '../utils/applicationError';
import { buildAuditorPenaltyReasonCode } from '../utils/auditorStakingReasonCode';

export { buildAuditorPenaltyReasonCode } from '../utils/auditorStakingReasonCode';

/** Áp dụng phạt một lần: slash phần cọc còn active và ghi nợ phần đã chuyển sang pending withdrawal. */
export async function applyAuditorPenalty(input: {
  auditorUserId: string;
  fieldReportId: string;
  fieldCaseId: string;
  milestoneIndex: number;
  amountVnd: number;
}): Promise<{ applied: boolean; collectedOnChainVnd: number; penaltyDebtVnd: number; txHash: string | null }> {
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd <= 0 || !Number.isInteger(input.milestoneIndex) || input.milestoneIndex < 0) {
    throw new ApplicationError('Dữ liệu phạt cọc không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
  const user = await findUserById(input.auditorUserId);
  if (!user?.walletAddress) throw new ApplicationError('Không tìm thấy ví Kiểm toán viên để phạt cọc.', 404, 'NOT_FOUND');

  const reasonCode = buildAuditorPenaltyReasonCode(input.fieldCaseId, input.auditorUserId);
  const ledgerEntry: AuditorPenaltyLedgerEntry = {
    ledgerId: crypto.randomUUID(),
    auditorUserId: input.auditorUserId,
    fieldReportId: input.fieldReportId,
    fieldCaseId: input.fieldCaseId,
    milestoneIndex: input.milestoneIndex,
    entryType: 'PENALTY',
    amount: String(input.amountVnd),
    txHash: null,
    reasonCode,
    status: 'PENDING',
    createdAt: new Date()
  };
  if (!await claimAuditorLedgerEntry(ledgerEntry)) {
    return { applied: false, collectedOnChainVnd: 0, penaltyDebtVnd: 0, txHash: null };
  }

  await initializeAuditorStakeGuard(input.auditorUserId);
  const contract = getReadOnlyAuditorStakingContract();
  const activeStake = await contract.stakedBalance(user.walletAddress) as bigint;
  const requestedAmount = BigInt(input.amountVnd);
  const collectedOnChain = activeStake < requestedAmount ? activeStake : requestedAmount;
  let txHash: string | null = null;
  if (collectedOnChain > 0n) {
    const transaction = await getWritableAuditorStakingContract().slash(user.walletAddress, collectedOnChain, reasonCode);
    const receipt = await transaction.wait(2);
    if (!receipt?.hash || receipt.status !== 1) {
      throw new Error('Giao dịch slash AuditorStaking không được xác nhận thành công.');
    }
    txHash = receipt.hash;
  }

  const penaltyDebtVnd = Number(requestedAmount - collectedOnChain);
  if (penaltyDebtVnd > 0 && !await increaseAuditorPenaltyDebt(input.auditorUserId, penaltyDebtVnd)) {
    throw new Error('Không thể ghi nợ phạt Auditor sau khi xử lý on-chain.');
  }
  await completeAuditorLedgerEntry(input.fieldReportId, 'PENALTY', txHash);
  return { applied: true, collectedOnChainVnd: Number(collectedOnChain), penaltyDebtVnd, txHash };
}
