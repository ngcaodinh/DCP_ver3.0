import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import {
  getAuditorStakingTreasurySigner,
  getReadOnlyAuditorStakingContract,
  getReadOnlyAuditorStakingProvider
} from '../config/auditorStakingContract';
import { getZeroDevConfig } from '../config/zeroDev';
import { findUserById } from '../models/authModel';
import { cancelAuditorPayout } from '../models/auditorPayoutModel';
import {
  createAuditorDebtSettlement,
  findAuditorDebtSettlementById,
  findRecoverableAuditorDebtSettlements,
  moveUncertainAuditorDebtSettlementsToManualReview,
  updateAuditorDebtSettlement,
  type AuditorDebtSettlement
} from '../models/auditorDebtSettlementModel';
import {
  acquireAuditorDebtSettlementLock,
  findAuditorPenaltyDebtCandidates,
  findAuditorStakeGuardByUserId,
  promoteAuditorDebtSettlementLockToPayout,
  releaseAuditorWalletLock,
  settleAuditorPenaltyDebt
} from '../models/auditorStakeGuardModel';
import { confirmStakeWithdrawalPayout, createStakeWithdrawalPayout } from '../services/auditorPayoutCreationService';
import { createKernelClientFromEncryptedOwnerKey } from '../services/zeroDevService';

const logger = getLogger();
const DEBT_SETTLEMENT_INTERVAL_MS = 60_000;
const UNCERTAIN_SETTLEMENT_MIN_AGE_MS = 10 * 60_000;
const settlementTokenAbi = [
  'function transfer(address,uint256) external returns (bool)',
  'function allowance(address,address) external view returns (uint256)',
  'function approve(address,uint256) external returns (bool)'
] as const;
const settlementStakingAbi = ['function fundRewardPool(uint256) external'] as const;
let settlementTimer: ReturnType<typeof setInterval> | null = null;
let isSettlementRunning = false;

type KernelClient = {
  account?: { address?: `0x${string}` };
  sendTransaction(payload: { calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: bigint }>; entryPointAddress: `0x${string}` }): Promise<string>;
};

/** Đọc token DCT có kiểm tra địa chỉ để không tạo UserOperation thu nợ trên cấu hình chain không hoàn chỉnh. */
function getDebtSettlementTokenAddress(): `0x${string}` {
  const tokenAddress = process.env.CHARITY_TOKEN_CONTRACT_ADDRESS?.trim() ?? '';
  if (!ethers.isAddress(tokenAddress)) throw new Error('CHARITY_TOKEN_CONTRACT_ADDRESS không hợp lệ cho debt settlement.');
  return ethers.getAddress(tokenAddress) as `0x${string}`;
}

/** Hoàn tất payout cash hoặc nhả lock khi toàn bộ khoản rút đã được bù vào nợ phạt. */
async function completeDebtSettlement(settlement: AuditorDebtSettlement): Promise<void> {
  const settledGuard = await settleAuditorPenaltyDebt(settlement.auditorUserId, settlement.settlementId, settlement.debtAmountVnd);
  if (!settledGuard) {
    const guard = await findAuditorStakeGuardByUserId(settlement.auditorUserId);
    if (guard?.lastSettledDebtSettlementId !== settlement.settlementId) {
      throw new Error('Could not durably settle the Auditor penalty debt.');
    }
  }
  const completed = await updateAuditorDebtSettlement(
    settlement.settlementId,
    'FUNDING_SUBMITTED',
    { status: 'COMPLETED', errorMessage: null }
  );
  if (!completed) return;
  if (settlement.payoutId && settlement.withdrawalTxHash) {
    const confirmedPayout = await confirmStakeWithdrawalPayout(settlement.auditorUserId, settlement.payoutId, settlement.withdrawalTxHash);
    if (!confirmedPayout) throw new Error('Không thể xác nhận payout cash sau debt settlement.');
    await promoteAuditorDebtSettlementLockToPayout(settlement.auditorUserId, settlement.settlementId, settlement.payoutId);
    return;
  }
  await releaseAuditorWalletLock(settlement.auditorUserId, settlement.settlementId, 'DEBT_SETTLING');
}

/** Nạp phần nợ DCT đã chuyển về treasury vào rewardPool, chỉ một lần theo settlement record. */
async function fundDebtRewardPool(settlement: AuditorDebtSettlement): Promise<void> {
  let fundTxHash = settlement.fundRewardPoolTxHash;
  if (!fundTxHash) {
    const submitting = await updateAuditorDebtSettlement(
      settlement.settlementId,
      'PENDING_FUNDING',
      { status: 'FUNDING_SUBMITTING', errorMessage: null }
    );
    if (!submitting) return;

    const treasurySigner = getAuditorStakingTreasurySigner();
    const token = new ethers.Contract(getDebtSettlementTokenAddress(), settlementTokenAbi, treasurySigner);
    const staking = getReadOnlyAuditorStakingContract();
    const stakingAddress = await staking.getAddress();
    const amount = BigInt(settlement.debtAmountVnd);
    if (await token.allowance(treasurySigner.address, stakingAddress) < amount) {
      const approval = await token.approve(stakingAddress, amount);
      const approvalReceipt = await approval.wait(2);
      if (!approvalReceipt?.hash || approvalReceipt.status !== 1) throw new Error('Approve treasury cho fundRewardPool thất bại.');
    }
    const fundingContract = new ethers.Contract(stakingAddress, settlementStakingAbi, treasurySigner);
    const transaction = await fundingContract.fundRewardPool(amount);
    fundTxHash = transaction.hash;
    const submitted = await updateAuditorDebtSettlement(
      settlement.settlementId,
      'FUNDING_SUBMITTING',
      { status: 'FUNDING_SUBMITTED', fundRewardPoolTxHash: fundTxHash, errorMessage: null }
    );
    if (!submitted) return;
  }
  if (!fundTxHash) throw new Error('Thiếu transaction hash fundRewardPool để xác nhận settlement.');
  const receipt = await getReadOnlyAuditorStakingProvider().waitForTransaction(fundTxHash, 2, 120_000);
  if (!receipt) return;
  if (receipt.status !== 1) throw new Error('fundRewardPool bị revert.');
  const latest = await findAuditorDebtSettlementById(settlement.settlementId);
  if (latest?.status === 'FUNDING_SUBMITTED') await completeDebtSettlement(latest);
}

/** Resume UserOperation đã gửi để process restart không gửi lại withdraw/transfer DCT. */
async function resumeDebtWithdrawal(settlement: AuditorDebtSettlement): Promise<void> {
  if (!settlement.withdrawalTxHash) return;
  const receipt = await getReadOnlyAuditorStakingProvider().waitForTransaction(settlement.withdrawalTxHash, 1, 120_000);
  if (!receipt) return;
  if (receipt.status !== 1) throw new Error('UserOperation withdraw/transfer debt bị revert.');
  const updated = await updateAuditorDebtSettlement(settlement.settlementId, 'WAITING_WITHDRAWAL', { status: 'PENDING_FUNDING', errorMessage: null });
  if (updated) await fundDebtRewardPool(updated);
}

/** Bắt đầu settlement cho một guard không lock: withdraw DCT rồi batch transfer phần nợ sang treasury. */
async function startDebtSettlement(auditorUserId: string, penaltyDebtVnd: number): Promise<void> {
  const settlementId = crypto.randomUUID();
  if (!await acquireAuditorDebtSettlementLock(auditorUserId, settlementId)) return;
  let settlement: AuditorDebtSettlement | null = null;
  try {
    const user = await findUserById(auditorUserId);
    if (!user?.walletAddress || !user.smartAccountOwnerEncryptedPrivateKey) throw new Error('Ví Auditor chưa sẵn sàng cho debt settlement.');
    const staking = getReadOnlyAuditorStakingContract();
    const [pendingAmount, releaseAt] = await Promise.all([
      staking.pendingWithdrawAmount(user.walletAddress) as Promise<bigint>,
      staking.unbondingReleaseAt(user.walletAddress) as Promise<bigint>
    ]);
    if (pendingAmount === 0n || releaseAt > BigInt(Math.floor(Date.now() / 1_000))) {
      await releaseAuditorWalletLock(auditorUserId, settlementId, 'DEBT_SETTLING');
      return;
    }
    if (pendingAmount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Khoản rút vượt giới hạn debt settlement tự động.');
    const debtAmount = Math.min(Number(pendingAmount), penaltyDebtVnd);
    const cashAmount = Number(pendingAmount) - debtAmount;
    const payoutId = cashAmount > 0 ? crypto.randomUUID() : null;
    const createdSettlement = await createAuditorDebtSettlement({
      settlementId, auditorUserId, payoutId, withdrawalAmountVnd: Number(pendingAmount), debtAmountVnd: debtAmount,
      withdrawalTxHash: null, fundRewardPoolTxHash: null, status: 'PENDING_WITHDRAWAL', errorMessage: null,
      createdAt: new Date(), updatedAt: new Date()
    });
    settlement = createdSettlement;
    if (payoutId) {
      // Settlement được lưu trước để payout cash luôn có owner bền vững nếu các bước gửi chain sau đó lỗi.
      await createStakeWithdrawalPayout({ auditorUserId, payoutId, sourceRefId: payoutId, onchainTxHash: null, amount: BigInt(cashAmount) });
    }
    const kernelClient = await createKernelClientFromEncryptedOwnerKey(user.smartAccountOwnerEncryptedPrivateKey) as unknown as KernelClient;
    if (!kernelClient.account?.address) throw new Error('Không thể khởi tạo smart account để thu nợ.');
    const tokenAddress = getDebtSettlementTokenAddress();
    const treasuryAddress = getAuditorStakingTreasurySigner().address;
    const stakingAddress = await staking.getAddress() as `0x${string}`;
    const entryPointAddress = getZeroDevConfig().entryPointAddress;
    const token = new ethers.Contract(tokenAddress, settlementTokenAbi, getReadOnlyAuditorStakingProvider());
    const calls = [
      { to: stakingAddress, data: staking.interface.encodeFunctionData('withdraw', []) as `0x${string}`, value: 0n },
      { to: tokenAddress, data: token.interface.encodeFunctionData('transfer', [treasuryAddress, BigInt(debtAmount)]) as `0x${string}`, value: 0n }
    ];
    const submitting = await updateAuditorDebtSettlement(
      createdSettlement.settlementId,
      'PENDING_WITHDRAWAL',
      { status: 'WITHDRAWAL_SUBMITTING', errorMessage: null }
    );
    if (!submitting) return;
    const txHash = await kernelClient.sendTransaction({
      calls,
      entryPointAddress
    });
    const waiting = await updateAuditorDebtSettlement(
      createdSettlement.settlementId,
      'WITHDRAWAL_SUBMITTING',
      { status: 'WAITING_WITHDRAWAL', withdrawalTxHash: txHash, errorMessage: null }
    );
    if (waiting) await resumeDebtWithdrawal(waiting);
  } catch (error) {
    logger.error('Không thể bắt đầu debt settlement Auditor.', { auditorUserId, errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR' });
    const persistedSettlement = settlement && await findAuditorDebtSettlementById(settlement.settlementId);
    if (!persistedSettlement) {
      await releaseAuditorWalletLock(auditorUserId, settlementId, 'DEBT_SETTLING');
      return;
    }
    if (persistedSettlement.status === 'PENDING_WITHDRAWAL') {
      if (persistedSettlement.payoutId) {
        await cancelAuditorPayout(persistedSettlement.payoutId, 'Debt settlement was not submitted on-chain.');
      }
      await releaseAuditorWalletLock(auditorUserId, settlementId, 'DEBT_SETTLING');
    }
  }
}

/** Quét debt mới và resume state machine bền vững theo interval, không chạy đồng thời giữa hai tick. */
async function runDebtSettlementSweep(): Promise<void> {
  if (isSettlementRunning) return;
  isSettlementRunning = true;
  try {
    await moveUncertainAuditorDebtSettlementsToManualReview(
      new Date(Date.now() - UNCERTAIN_SETTLEMENT_MIN_AGE_MS)
    );
    const recoverable = await findRecoverableAuditorDebtSettlements(100);
    for (const settlement of recoverable) {
      try {
        if (settlement.status === 'WAITING_WITHDRAWAL') await resumeDebtWithdrawal(settlement);
        else await fundDebtRewardPool(settlement);
      } catch (error) {
        logger.error('Không thể resume debt settlement Auditor.', { settlementId: settlement.settlementId, errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR' });
      }
    }
    const candidates = await findAuditorPenaltyDebtCandidates(100);
    for (const candidate of candidates) {
      await startDebtSettlement(candidate.auditorUserId, candidate.penaltyDebtVnd);
    }
  } finally {
    isSettlementRunning = false;
  }
}

/** Khởi động worker thu nợ pending withdrawal; thiếu config chỉ khiến lần có debt bị log lỗi, không làm server crash. */
export function startAuditorDebtSettlementWorker(): void {
  if (settlementTimer) return;
  void runDebtSettlementSweep();
  settlementTimer = setInterval(() => void runDebtSettlementSweep(), DEBT_SETTLEMENT_INTERVAL_MS);
}

/** Dừng scheduler thu nợ để graceful shutdown không khởi tạo settlement mới. */
export function stopAuditorDebtSettlementWorker(): void {
  if (settlementTimer) clearInterval(settlementTimer);
  settlementTimer = null;
  isSettlementRunning = false;
}

/** Test hooks for durable recovery paths; they must not be called by runtime code. */
export const __auditorDebtSettlementWorkerTestHooks = {
  completeDebtSettlement,
  runDebtSettlementSweep,
  startDebtSettlement
};
