import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimEntry: vi.fn(),
  findEntry: vi.fn(),
  sumCompletedRewards: vi.fn(),
  sumReservedPayouts: vi.fn(),
  buildReasonCode: vi.fn()
}));

vi.mock('node:crypto', () => ({ default: { randomUUID: () => 'ledger-1' } }));
vi.mock('../../models/auditorPenaltyLedgerModel', () => ({
  claimAuditorLedgerEntry: mocks.claimEntry,
  findAuditorLedgerEntryByFieldReportAndType: mocks.findEntry,
  sumCompletedAuditorRewardLedgerEntries: mocks.sumCompletedRewards
}));
vi.mock('../../models/auditorPayoutModel', () => ({ sumReservedAuditorRewardPayoutsByUserId: mocks.sumReservedPayouts }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ info: vi.fn() }) }));
vi.mock('../../utils/auditorStakingReasonCode', () => ({ buildAuditorRewardReasonCode: mocks.buildReasonCode }));

import { getAuditorClaimableRewardVnd, scheduleAuditorReward } from '../../services/auditorRewardService';

describe('auditor reward service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildReasonCode.mockReturnValue('REWARD:report-1:auditor-1');
  });

  it('schedules a pending reward with a seven-day waiting period', async () => {
    mocks.claimEntry.mockResolvedValue(true);
    const before = Date.now();

    const entry = await scheduleAuditorReward({ auditorUserId: 'auditor-1', fieldReportId: 'report-1', fieldCaseId: 'case-1', milestoneIndex: 0, amountVnd: 100_000 });

    expect(entry).toMatchObject({ entryType: 'REWARD', status: 'PENDING', amount: '100000', reasonCode: 'REWARD:report-1:auditor-1' });
    expect(mocks.buildReasonCode).toHaveBeenCalledWith('report-1', 'auditor-1');
    expect(entry.payableAt?.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1_000);
  });

  it('returns the existing reward when the ledger uniqueness claim loses a race', async () => {
    const existing = {
      fieldReportId: 'report-1', entryType: 'REWARD', auditorUserId: 'auditor-1', ledgerId: 'existing-ledger',
      fieldCaseId: 'case-1', milestoneIndex: 0, amount: '100000', reasonCode: 'REWARD:report-1:auditor-1'
    };
    mocks.claimEntry.mockResolvedValue(false);
    mocks.findEntry.mockResolvedValue(existing);

    await expect(scheduleAuditorReward({ auditorUserId: 'auditor-1', fieldReportId: 'report-1', fieldCaseId: 'case-1', milestoneIndex: 0, amountVnd: 100_000 })).resolves.toBe(existing);
  });

  it('rejects a conflicting repeat decision instead of returning a reward with a different amount', async () => {
    mocks.claimEntry.mockResolvedValue(false);
    mocks.findEntry.mockResolvedValue({
      fieldReportId: 'report-1', entryType: 'REWARD', auditorUserId: 'auditor-1', ledgerId: 'existing-ledger',
      fieldCaseId: 'case-1', milestoneIndex: 0, amount: '99999', reasonCode: 'REWARD:report-1:auditor-1'
    });

    await expect(scheduleAuditorReward({ auditorUserId: 'auditor-1', fieldReportId: 'report-1', fieldCaseId: 'case-1', milestoneIndex: 0, amountVnd: 100_000 }))
      .rejects.toMatchObject({ errorCode: 'CONFLICT' });
  });

  it('subtracts every non-cancelled reward payout from credited rewards', async () => {
    mocks.sumCompletedRewards.mockResolvedValue(200_000);
    mocks.sumReservedPayouts.mockResolvedValue(50_000);

    await expect(getAuditorClaimableRewardVnd('auditor-1')).resolves.toBe(150_000);
  });

  it('uses already loaded entries without reloading the reward ledger', async () => {
    mocks.sumReservedPayouts.mockResolvedValue(50_000);

    await expect(getAuditorClaimableRewardVnd('auditor-1', [
      { entryType: 'REWARD', status: 'COMPLETED', amount: '200000' } as never
    ])).resolves.toBe(150_000);

    expect(mocks.sumCompletedRewards).not.toHaveBeenCalled();
  });

  it('rejects unsafe or non-positive reward amounts before writing a ledger entry', async () => {
    await expect(scheduleAuditorReward({ auditorUserId: 'auditor-1', fieldReportId: 'report-1', fieldCaseId: 'case-1', milestoneIndex: 0, amountVnd: 0 }))
      .rejects.toMatchObject({ errorCode: 'AMOUNT_INVALID' });

    expect(mocks.claimEntry).not.toHaveBeenCalled();
  });
});
