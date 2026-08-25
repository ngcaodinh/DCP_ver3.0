import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimLedger: vi.fn(),
  completeLedger: vi.fn(),
  findUser: vi.fn(),
  increaseDebt: vi.fn(),
  initializeGuard: vi.fn(),
  slash: vi.fn(),
  stakedBalance: vi.fn()
}));

vi.mock('../../config/auditorStakingContract', () => ({
  getReadOnlyAuditorStakingContract: () => ({ stakedBalance: mocks.stakedBalance }),
  getWritableAuditorStakingContract: () => ({ slash: mocks.slash })
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUser }));
vi.mock('../../models/auditorPenaltyLedgerModel', () => ({
  claimAuditorLedgerEntry: mocks.claimLedger,
  completeAuditorLedgerEntry: mocks.completeLedger
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({
  increaseAuditorPenaltyDebt: mocks.increaseDebt,
  initializeAuditorStakeGuard: mocks.initializeGuard
}));

import { applyAuditorPenalty, buildAuditorPenaltyReasonCode } from '../../services/auditorPenaltyService';

describe('auditor penalty service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ walletAddress: '0x0000000000000000000000000000000000000001' });
    mocks.claimLedger.mockResolvedValue(true);
    mocks.increaseDebt.mockResolvedValue({ penaltyDebtVnd: 1 });
    mocks.completeLedger.mockResolvedValue(undefined);
  });

  it('slashes exactly the requested active stake and creates no debt when stake is sufficient', async () => {
    mocks.stakedBalance.mockResolvedValue(3_000_000n);
    mocks.slash.mockResolvedValue({ wait: vi.fn().mockResolvedValue({ hash: '0xslash', status: 1 }) });

    await expect(applyAuditorPenalty({
      auditorUserId: 'auditor-1', fieldReportId: 'report-1', fieldCaseId: 'case-1', milestoneIndex: 0, amountVnd: 900_000
    })).resolves.toEqual({ applied: true, collectedOnChainVnd: 900_000, penaltyDebtVnd: 0, txHash: '0xslash' });

    expect(mocks.slash).toHaveBeenCalledWith('0x0000000000000000000000000000000000000001', 900_000n, 'PENALTY:case-1:auditor-1');
    expect(mocks.increaseDebt).not.toHaveBeenCalled();
  });

  it('records the full debt when the stake has already moved to pending withdrawal', async () => {
    mocks.stakedBalance.mockResolvedValue(0n);

    await expect(applyAuditorPenalty({
      auditorUserId: 'auditor-1', fieldReportId: 'report-2', fieldCaseId: 'case-2', milestoneIndex: 1, amountVnd: 900_000
    })).resolves.toMatchObject({ applied: true, collectedOnChainVnd: 0, penaltyDebtVnd: 900_000, txHash: null });

    expect(mocks.slash).not.toHaveBeenCalled();
    expect(mocks.increaseDebt).toHaveBeenCalledWith('auditor-1', 900_000);
  });

  it('does not repeat chain side effects when the ledger claim is already owned by a prior attempt', async () => {
    mocks.claimLedger.mockResolvedValue(false);

    await expect(applyAuditorPenalty({
      auditorUserId: 'auditor-1', fieldReportId: 'report-3', fieldCaseId: 'case-3', milestoneIndex: 2, amountVnd: 900_000
    })).resolves.toEqual({ applied: false, collectedOnChainVnd: 0, penaltyDebtVnd: 0, txHash: null });

    expect(mocks.slash).not.toHaveBeenCalled();
    expect(mocks.increaseDebt).not.toHaveBeenCalled();
  });

  it('separates PENALTY reason codes from reward namespace and rejects blank identifiers', () => {
    expect(buildAuditorPenaltyReasonCode('case-1', 'auditor-1')).toBe('PENALTY:case-1:auditor-1');
    expect(() => buildAuditorPenaltyReasonCode('', 'auditor-1')).toThrow('Mã vụ việc không được để trống.');
  });
});
