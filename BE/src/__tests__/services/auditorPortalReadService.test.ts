import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPayoutAccount: vi.fn(),
  findStakeGuard: vi.fn(),
  findUser: vi.fn(),
  stakingContract: vi.fn()
}));

vi.mock('../../config/auditorStakingContract', () => ({
  getReadOnlyAuditorStakingContract: mocks.stakingContract
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUser }));
vi.mock('../../models/auditorPayoutAccountModel', () => ({
  findAuditorPayoutAccountByUserId: mocks.findPayoutAccount
}));
vi.mock('../../models/auditorPayoutModel', () => ({ listAuditorPayoutsByUserId: vi.fn() }));
vi.mock('../../models/auditorPenaltyLedgerModel', () => ({ listAuditorLedgerEntries: vi.fn() }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ findAuditorStakeGuardByUserId: mocks.findStakeGuard }));
vi.mock('../../services/auditorRewardService', () => ({ getAuditorClaimableRewardVnd: vi.fn() }));
vi.mock('../../services/auditorStakeEligibility.service', () => ({ evaluateAuditorFullExitEligibility: vi.fn() }));

import { getAuditorStakeOverview } from '../../services/auditorPortalReadService';

describe('auditor portal stake overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ walletAddress: '0x00000000000000000000000000000000000000a1', accountStatus: 'ACTIVE', suspendedReasonCode: null });
    mocks.findStakeGuard.mockResolvedValue({ walletLock: null, lockedAt: null, penaltyDebtVnd: 0, openCaseIds: [] });
    mocks.findPayoutAccount.mockResolvedValue({
      bankName: 'MB', bankCode: 'MB', bankAccountNumber: '0367400325', accountHolderName: 'NGUYEN VAN A', branchName: 'Ha Noi', updatedAt: new Date()
    });
    mocks.stakingContract.mockReturnValue({
      stakedBalance: vi.fn().mockResolvedValue(3_000_000n),
      minimumStakeThreshold: vi.fn().mockResolvedValue(3_000_000n),
      pendingWithdrawAmount: vi.fn().mockResolvedValue(0n),
      unbondingReleaseAt: vi.fn().mockResolvedValue(0n),
      unbondingPeriodSeconds: vi.fn().mockResolvedValue(604_800n)
    });
  });

  it('returns only the masked payout account number to the auditor browser', async () => {
    const overview = await getAuditorStakeOverview('auditor-1') as {
      payoutAccount: Record<string, unknown> | null;
    };

    expect(overview.payoutAccount).toMatchObject({
      bankName: 'MB', bankAccountNumberMasked: '****0325', accountHolderName: 'NGUYEN VAN A', branchName: 'Ha Noi'
    });
    expect(overview.payoutAccount).not.toHaveProperty('bankAccountNumber');
    expect(overview.payoutAccount).not.toHaveProperty('bankCode');
  });
});
