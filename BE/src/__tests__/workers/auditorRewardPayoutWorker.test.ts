import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeEntry: vi.fn(),
  findClaimable: vi.fn(),
  findUser: vi.fn(),
  rewardPool: vi.fn(),
  payReward: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  queryFilter: vi.fn()
}));

vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: mocks.loggerError, warn: mocks.loggerWarn, info: mocks.loggerInfo }) }));
vi.mock('../../config/auditorStakingContract', () => ({
  getReadOnlyAuditorStakingContract: () => ({ rewardPool: mocks.rewardPool, queryFilter: mocks.queryFilter, filters: { Rewarded: vi.fn() } }),
  getWritableAuditorStakingContract: () => ({ payReward: mocks.payReward })
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUser }));
vi.mock('../../models/auditorPenaltyLedgerModel', () => ({
  completeAuditorLedgerEntry: mocks.completeEntry,
  findClaimableAuditorRewardLedgerEntries: mocks.findClaimable
}));

import { sweepClaimableAuditorRewards } from '../../workers/auditorRewardPayoutWorker';

const entry = { ledgerId: 'ledger-1', auditorUserId: 'auditor-1', fieldReportId: 'report-1', amount: '100000', reasonCode: 'REWARD:case-1:auditor-1' };

describe('auditor reward payout worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findClaimable.mockResolvedValue([entry]);
    mocks.findUser.mockResolvedValue({ walletAddress: '0x0000000000000000000000000000000000000001' });
  });

  it('completes the ledger only after a successful two-confirmation reward transaction', async () => {
    const wait = vi.fn().mockResolvedValue({ status: 1, hash: '0xreward' });
    mocks.payReward.mockResolvedValue({ wait });

    await sweepClaimableAuditorRewards();

    expect(mocks.payReward).toHaveBeenCalledWith('0x0000000000000000000000000000000000000001', 100000n, entry.reasonCode);
    expect(wait).toHaveBeenCalledWith(2);
    expect(mocks.completeEntry).toHaveBeenCalledWith('report-1', 'REWARD', 'auditor-1', '0xreward');
  });

  it('keeps the ledger pending when the reward pool is insufficient', async () => {
    mocks.payReward.mockRejectedValue({ code: 'CALL_EXCEPTION', revert: { name: 'InsufficientRewardPool' }, data: '0xdeadbeef' });
    mocks.rewardPool.mockResolvedValue(0n);

    await sweepClaimableAuditorRewards();

    expect(mocks.completeEntry).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringMatching(/Quỹ thưởng/), expect.objectContaining({ requiredAmount: '100000', rewardPool: '0' }));
  });

  it('recovers a pending ledger from its matching Rewarded event after an already processed reason code', async () => {
    mocks.payReward.mockRejectedValue({ code: 'CALL_EXCEPTION', revert: { name: 'AlreadyProcessedReasonCode' }, data: '0xdeadbeef' });
    mocks.queryFilter.mockResolvedValue([{ args: ['0x0000000000000000000000000000000000000001', 100000n, entry.reasonCode], transactionHash: '0xrecovered' }]);

    await sweepClaimableAuditorRewards();

    expect(mocks.completeEntry).toHaveBeenCalledWith('report-1', 'REWARD', 'auditor-1', '0xrecovered');
    expect(mocks.loggerInfo).toHaveBeenCalledWith(expect.stringMatching(/phục hồi ledger/), expect.objectContaining({ reasonCode: entry.reasonCode }));
  });

  it('keeps sweeping when recovery cannot read the Auditor account', async () => {
    mocks.payReward.mockRejectedValue({ code: 'CALL_EXCEPTION', revert: { name: 'AlreadyProcessedReasonCode' }, data: '0xdeadbeef' });
    mocks.findUser.mockResolvedValueOnce({ walletAddress: '0x0000000000000000000000000000000000000001' }).mockRejectedValueOnce(new Error('Mongo unavailable'));

    await expect(sweepClaimableAuditorRewards()).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringMatching(/Không thể đối soát Rewarded event/), expect.any(Object));
  });

  it('keeps the ledger pending when a mined reward transaction has a failed receipt', async () => {
    mocks.payReward.mockResolvedValue({ wait: vi.fn().mockResolvedValue({ status: 0, hash: '0xreverted' }) });

    await sweepClaimableAuditorRewards();

    expect(mocks.completeEntry).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringMatching(/không được xác nhận/), expect.any(Object));
  });
});
