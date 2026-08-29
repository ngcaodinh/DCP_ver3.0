import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findStaleGuards: vi.fn(),
  findPayout: vi.fn(),
  releaseLock: vi.fn(),
  updatePayout: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ error: mocks.loggerError, warn: mocks.loggerWarn })
}));
vi.mock('../../models/auditorPayoutModel', () => ({
  claimAuditorPayoutForTransfer: vi.fn(),
  findAuditorPayoutById: mocks.findPayout,
  findPendingAuditorPayouts: vi.fn(),
  rotateAuditorPayoutTransferIdempotencyKey: vi.fn(),
  updateAuditorPayout: mocks.updatePayout
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({
  findStaleAuditorStakeGuards: mocks.findStaleGuards,
  releaseAuditorWalletLock: mocks.releaseLock
}));
vi.mock('../../constants/auditorStaking', () => ({ AUDITOR_STAKE_GUARD_STALE_LOCK_MS: 1 }));
vi.mock('../../queues/auditorPayoutQueue', () => ({
  AUDITOR_PAYOUT_RETRY_DELAYS_MS: [1],
  enqueueAuditorPayout: vi.fn(),
  getAuditorPayoutQueue: vi.fn()
}));
vi.mock('../../services/auditorPayoutService', () => ({
  finalizeAuditorPayoutAfterPayosSuccess: vi.fn(),
  hasAuditorPayoutBalance: vi.fn()
}));
vi.mock('../../services/payosService', () => ({
  createPayosTransfer: vi.fn(),
  getPayosTransferStatusByReferenceId: vi.fn()
}));

import { __auditorPayoutWorkerTestHooks } from '../../workers/auditorPayoutWorker';

describe('auditor payout stale-lock recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findStaleGuards.mockResolvedValue([]);
  });

  it('keeps the wallet locked when a prepared payout has no durable Withdrawn hash', async () => {
    mocks.findStaleGuards.mockResolvedValue([{
      auditorUserId: 'auditor-1', lockRefId: 'payout-1', walletLock: 'WITHDRAWING'
    }]);
    mocks.findPayout.mockResolvedValue({ payoutId: 'payout-1', status: 'PENDING', onchainTxHash: null });

    await __auditorPayoutWorkerTestHooks.sweepOrphanedAuditorWalletLocks();

    expect(mocks.updatePayout).toHaveBeenCalledWith('payout-1', expect.objectContaining({ status: 'MANUAL_REVIEW' }));
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('releases a genuinely orphaned lock with no payout record', async () => {
    mocks.findStaleGuards.mockResolvedValue([{
      auditorUserId: 'auditor-1', lockRefId: 'missing-payout', walletLock: 'WITHDRAWING'
    }]);
    mocks.findPayout.mockResolvedValue(null);

    await __auditorPayoutWorkerTestHooks.sweepOrphanedAuditorWalletLocks();

    expect(mocks.updatePayout).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledWith('auditor-1', 'missing-payout', 'WITHDRAWING');
  });

  it('keeps a reward payout eligible for retry instead of moving it to manual review', async () => {
    mocks.findStaleGuards.mockResolvedValue([{
      auditorUserId: 'auditor-1', lockRefId: 'reward-payout-1', walletLock: 'PAYOUT_IN_FLIGHT'
    }]);
    mocks.findPayout.mockResolvedValue({ payoutId: 'reward-payout-1', payoutType: 'REWARD', status: 'PENDING', onchainTxHash: null });

    await __auditorPayoutWorkerTestHooks.sweepOrphanedAuditorWalletLocks();

    expect(mocks.updatePayout).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});
