import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  moveUncertain: vi.fn(),
  createSettlement: vi.fn(),
  findRecoverable: vi.fn(),
  findSettlementById: vi.fn(),
  findDebtCandidates: vi.fn(),
  findGuard: vi.fn(),
  acquireSettlementLock: vi.fn(),
  findUser: vi.fn(),
  cancelPayout: vi.fn(),
  createPayout: vi.fn(),
  createKernelClient: vi.fn(),
  stakingContract: vi.fn(),
  releaseLock: vi.fn(),
  settleDebt: vi.fn(),
  updateSettlement: vi.fn(),
  loggerError: vi.fn()
}));

vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: mocks.loggerError }) }));
vi.mock('../../config/auditorStakingContract', () => ({
  getAuditorStakingTreasurySigner: vi.fn(),
  getReadOnlyAuditorStakingContract: mocks.stakingContract,
  getReadOnlyAuditorStakingProvider: vi.fn()
}));
vi.mock('../../config/zeroDev', () => ({ getZeroDevConfig: vi.fn() }));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUser }));
vi.mock('../../models/auditorDebtSettlementModel', () => ({
  createAuditorDebtSettlement: mocks.createSettlement,
  findAuditorDebtSettlementById: mocks.findSettlementById,
  findRecoverableAuditorDebtSettlements: mocks.findRecoverable,
  moveUncertainAuditorDebtSettlementsToManualReview: mocks.moveUncertain,
  updateAuditorDebtSettlement: mocks.updateSettlement
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({
  acquireAuditorDebtSettlementLock: mocks.acquireSettlementLock,
  findAuditorPenaltyDebtCandidates: mocks.findDebtCandidates,
  findAuditorStakeGuardByUserId: mocks.findGuard,
  promoteAuditorDebtSettlementLockToPayout: vi.fn(),
  releaseAuditorWalletLock: mocks.releaseLock,
  settleAuditorPenaltyDebt: mocks.settleDebt
}));
vi.mock('../../services/auditorPayoutCreationService', () => ({
  confirmStakeWithdrawalPayout: vi.fn(),
  createStakeWithdrawalPayout: mocks.createPayout
}));
vi.mock('../../models/auditorPayoutModel', () => ({ cancelAuditorPayout: mocks.cancelPayout }));
vi.mock('../../services/zeroDevService', () => ({ createKernelClientFromEncryptedOwnerKey: mocks.createKernelClient }));

import { __auditorDebtSettlementWorkerTestHooks } from '../../workers/auditorDebtSettlementWorker';

describe('auditor debt settlement recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveUncertain.mockResolvedValue(undefined);
    mocks.createSettlement.mockResolvedValue({ settlementId: 'settlement-1', payoutId: 'payout-1', status: 'PENDING_WITHDRAWAL' });
    mocks.findRecoverable.mockResolvedValue([]);
    mocks.findSettlementById.mockResolvedValue({ settlementId: 'settlement-1', payoutId: 'payout-1', status: 'PENDING_WITHDRAWAL' });
    mocks.findDebtCandidates.mockResolvedValue([]);
    mocks.acquireSettlementLock.mockResolvedValue({ walletLock: 'DEBT_SETTLING' });
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      walletAddress: '0x0000000000000000000000000000000000000001',
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-key'
    });
    mocks.createPayout.mockResolvedValue({ payoutId: 'payout-1' });
    mocks.createKernelClient.mockRejectedValue(new Error('ZeroDev unavailable'));
    mocks.stakingContract.mockReturnValue({
      pendingWithdrawAmount: vi.fn().mockResolvedValue(100_000n),
      unbondingReleaseAt: vi.fn().mockResolvedValue(0n)
    });
    mocks.settleDebt.mockResolvedValue({ penaltyDebtVnd: 0 });
    mocks.updateSettlement.mockResolvedValue({
      settlementId: 'settlement-1', auditorUserId: 'auditor-1', payoutId: null, withdrawalTxHash: null
    });
  });

  it('moves uncertain submission windows to manual review before it resumes any settlement', async () => {
    await __auditorDebtSettlementWorkerTestHooks.runDebtSettlementSweep();

    expect(mocks.moveUncertain).toHaveBeenCalledWith(expect.any(Date));
    expect(mocks.findRecoverable).toHaveBeenCalledWith(100);
    expect(mocks.findDebtCandidates).toHaveBeenCalledWith(100);
    expect(mocks.moveUncertain.mock.invocationCallOrder[0]).toBeLessThan(mocks.findRecoverable.mock.invocationCallOrder[0]);
  });

  it('releases the debt lock and cancels the prepared payout when setup fails before a withdrawal is submitted', async () => {
    await __auditorDebtSettlementWorkerTestHooks.startDebtSettlement('auditor-1', 50_000);

    expect(mocks.createSettlement).toHaveBeenCalledWith(expect.objectContaining({
      payoutId: expect.any(String),
      status: 'PENDING_WITHDRAWAL'
    }));
    expect(mocks.createPayout).toHaveBeenCalledWith(expect.objectContaining({ onchainTxHash: null }));
    expect(mocks.cancelPayout).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(mocks.releaseLock).toHaveBeenCalledWith('auditor-1', expect.any(String), 'DEBT_SETTLING');
  });

  it('finishes a settlement exactly once after the debt decrement was committed before a process crash', async () => {
    mocks.settleDebt.mockResolvedValue(null);
    mocks.findGuard.mockResolvedValue({ lastSettledDebtSettlementId: 'settlement-1' });

    await __auditorDebtSettlementWorkerTestHooks.completeDebtSettlement({
      settlementId: 'settlement-1',
      auditorUserId: 'auditor-1',
      payoutId: null,
      withdrawalAmountVnd: 100,
      debtAmountVnd: 100,
      withdrawalTxHash: null,
      fundRewardPoolTxHash: '0xfunding',
      status: 'FUNDING_SUBMITTED',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    expect(mocks.updateSettlement).toHaveBeenCalledWith(
      'settlement-1',
      'FUNDING_SUBMITTED',
      { status: 'COMPLETED', errorMessage: null }
    );
    expect(mocks.releaseLock).toHaveBeenCalledWith('auditor-1', 'settlement-1', 'DEBT_SETTLING');
  });
});
