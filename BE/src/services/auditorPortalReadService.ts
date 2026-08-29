import { getReadOnlyAuditorStakingContract } from '../config/auditorStakingContract';
import { findUserById } from '../models/authModel';
import { findAuditorPayoutAccountByUserId } from '../models/auditorPayoutAccountModel';
import { listAuditorPayoutsByUserId } from '../models/auditorPayoutModel';
import { listAuditorLedgerEntries } from '../models/auditorPenaltyLedgerModel';
import { findAuditorStakeGuardByUserId } from '../models/auditorStakeGuardModel';
import { getAuditorClaimableRewardVnd } from './auditorRewardService';
import { evaluateAuditorFullExitEligibility } from './auditorStakeEligibility.service';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

/** Chuẩn hóa số lượng bản ghi lịch sử để mọi truy vấn portal luôn có giới hạn hữu hạn. */
export function normalizeAuditorPortalHistoryLimit(rawLimit: unknown): number {
  const parsedLimit = Number(rawLimit);
  if (!Number.isFinite(parsedLimit)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(parsedLimit)));
}

/** Che số tài khoản ngân hàng trước khi dữ liệu rời khỏi lớp dịch vụ. */
function maskBankAccountNumber(bankAccountNumber: string): string {
  return `****${bankAccountNumber.slice(-4)}`;
}

/** Đọc trạng thái cọc on-chain theo hai đợt để tôn trọng giới hạn batch RPC là ba request. */
async function readAuditorOnchainStake(walletAddress: string): Promise<{
  stakedBalance: string;
  minimumStakeThreshold: string;
  pendingWithdrawAmount: string;
  unbondingReleaseAt: string | null;
  unbondingPeriodSeconds: string;
}> {
  const contract = getReadOnlyAuditorStakingContract();
  const [stakedBalance, minimumStakeThreshold, pendingWithdrawAmount] = await Promise.all([
    contract.stakedBalance(walletAddress),
    contract.minimumStakeThreshold(),
    contract.pendingWithdrawAmount(walletAddress)
  ]);
  const [unbondingReleaseAt, unbondingPeriodSeconds] = await Promise.all([
    contract.unbondingReleaseAt(walletAddress),
    contract.unbondingPeriodSeconds()
  ]);
  const releaseAtSeconds = BigInt(unbondingReleaseAt.toString());
  return {
    stakedBalance: stakedBalance.toString(),
    minimumStakeThreshold: minimumStakeThreshold.toString(),
    pendingWithdrawAmount: pendingWithdrawAmount.toString(),
    unbondingReleaseAt: releaseAtSeconds === 0n ? null : new Date(Number(releaseAtSeconds) * 1_000).toISOString(),
    unbondingPeriodSeconds: unbondingPeriodSeconds.toString()
  };
}

/** Lấy tổng quan cọc; chỉ tính điều kiện thoát vai trò khi màn hình thực sự cần hiển thị quyết định đó. */
export async function getAuditorStakeOverview(auditorUserId: string, withExitEligibility = false): Promise<unknown> {
  const [user, guard, payoutAccount] = await Promise.all([
    findUserById(auditorUserId),
    findAuditorStakeGuardByUserId(auditorUserId),
    findAuditorPayoutAccountByUserId(auditorUserId)
  ]);
  // Eligibility dùng DB độc lập với RPC nên chạy song song, nhưng vẫn re-check trước giao dịch thật ở service rút cọc.
  const exitEligibilityPromise = withExitEligibility
    ? evaluateAuditorFullExitEligibility(auditorUserId, { guard })
    : Promise.resolve(null);
  let onchain: Awaited<ReturnType<typeof readAuditorOnchainStake>> | null = null;
  let onchainError: 'BLOCKCHAIN_UNAVAILABLE' | null = null;
  try {
    onchain = await readAuditorOnchainStake(user?.walletAddress || '');
  } catch {
    onchainError = 'BLOCKCHAIN_UNAVAILABLE';
  }
  const exitEligibility = await exitEligibilityPromise;
  return {
    walletAddress: user?.walletAddress || null,
    accountStatus: user?.accountStatus || null,
    suspendedReasonCode: user?.suspendedReasonCode || null,
    onchain,
    onchainError,
    guard: {
      walletLock: guard?.walletLock || null,
      lockedAt: guard?.lockedAt || null,
      penaltyDebtVnd: guard?.penaltyDebtVnd || 0,
      openCaseCount: guard?.openCaseIds.length || 0
    },
    exitEligibility,
    payoutAccount: payoutAccount ? {
      bankName: payoutAccount.bankName,
      bankAccountNumberMasked: maskBankAccountNumber(payoutAccount.bankAccountNumber),
      accountHolderName: payoutAccount.accountHolderName,
      branchName: payoutAccount.branchName,
      updatedAt: payoutAccount.updatedAt
    } : null
  };
}

/** Lấy sổ thưởng phạt và payout đã che PII, giới hạn bằng tham số đã chuẩn hóa. */
export async function getAuditorEarnings(auditorUserId: string, rawLimit: unknown): Promise<unknown> {
  const limit = normalizeAuditorPortalHistoryLimit(rawLimit);
  const [ledgerEntries, payouts] = await Promise.all([
    listAuditorLedgerEntries(auditorUserId),
    listAuditorPayoutsByUserId(auditorUserId, limit)
  ]);
  const claimableRewardVnd = await getAuditorClaimableRewardVnd(auditorUserId, ledgerEntries);
  return {
    claimableRewardVnd,
    // Model ledger hiện không nhận limit nên cắt tại service để không đổi hợp đồng sẵn có.
    ledgerEntries: ledgerEntries.slice(0, limit).map(entry => ({
      ledgerId: entry.ledgerId, entryType: entry.entryType, amount: entry.amount, status: entry.status,
      reasonCode: entry.reasonCode, txHash: entry.txHash, milestoneIndex: entry.milestoneIndex,
      fieldReportId: entry.fieldReportId, createdAt: entry.createdAt
    })),
    payouts: payouts.map(payout => ({
      payoutId: payout.payoutId, payoutType: payout.payoutType, status: payout.status,
      amountVnd: payout.amountVnd, feeVnd: payout.feeVnd, netAmountVnd: payout.netAmountVnd,
      bankSnapshot: {
        bankName: payout.bankSnapshot.bankName, bankCode: payout.bankSnapshot.bankCode,
        bankAccountNumberMasked: maskBankAccountNumber(payout.bankSnapshot.bankAccountNumber),
        accountHolderName: payout.bankSnapshot.accountHolderName
      },
      payosTransferId: payout.payosTransferId, onchainTxHash: payout.onchainTxHash,
      errorMessage: payout.errorMessage, attemptNumber: payout.attemptNumber,
      createdAt: payout.createdAt, updatedAt: payout.updatedAt
    }))
  };
}
