import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreatePayout, mockEnqueue, mockFindAccount, mockFindById, mockFindBySource, mockLinkWithdrawal, mockPromoteLock, mockWarn } = vi.hoisted(() => ({
  mockCreatePayout: vi.fn(),
  mockEnqueue: vi.fn(),
  mockFindAccount: vi.fn(),
  mockFindById: vi.fn(),
  mockFindBySource: vi.fn(),
  mockLinkWithdrawal: vi.fn(),
  mockPromoteLock: vi.fn(),
  mockWarn: vi.fn()
}));

vi.mock('../../config/logger', () => ({ getLogger: () => ({ warn: mockWarn }) }));
vi.mock('../../models/auditorPayoutAccountModel', () => ({ findAuditorPayoutAccountByUserId: mockFindAccount }));
vi.mock('../../models/auditorPayoutModel', () => ({
  createAuditorPayout: mockCreatePayout,
  findAuditorPayoutById: mockFindById,
  linkAuditorPayoutToOnchainWithdrawal: mockLinkWithdrawal,
  findAuditorPayoutBySource: mockFindBySource
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({ promoteAuditorWithdrawalLockToPayout: mockPromoteLock }));
vi.mock('../../queues/auditorPayoutQueue', () => ({ enqueueAuditorPayout: mockEnqueue }));

import { confirmStakeWithdrawalPayout, createStakeWithdrawalPayout } from '../../services/auditorPayoutCreationService';

describe('stake withdrawal payout creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUDITOR_PAYOUT_FEE_VND = '5000';
    mockFindAccount.mockResolvedValue({
      bankName: 'Vietcombank', bankCode: 'VCB', bankAccountNumber: '0123456789', accountHolderName: 'NGUYEN VAN A'
    });
    mockCreatePayout.mockImplementation(async (payout: unknown) => payout);
    mockEnqueue.mockResolvedValue(true);
  });

  it('creates one snapshot payout with the configured user fee from a confirmed withdrawal', async () => {
    mockFindBySource.mockResolvedValue(null);

    const payout = await createStakeWithdrawalPayout({
      auditorUserId: 'auditor-1', onchainTxHash: '0xwithdrawn', amount: 3_000_000n
    });

    expect(mockCreatePayout).toHaveBeenCalledWith(expect.objectContaining({
      payoutType: 'STAKE_WITHDRAWAL', sourceRefId: '0xwithdrawn', amountVnd: 3_000_000,
      feeVnd: 5_000, netAmountVnd: 2_995_000, status: 'PENDING',
      bankSnapshot: expect.objectContaining({ bankAccountNumber: '0123456789', accountHolderName: 'NGUYEN VAN A' })
    }));
    expect(mockEnqueue).toHaveBeenCalledWith(payout.payoutId);
  });

  it('rejects a withdrawal whose gross value cannot cover the configured transfer fee', async () => {
    mockFindBySource.mockResolvedValue(null);
    process.env.AUDITOR_PAYOUT_FEE_VND = '5000';

    await expect(createStakeWithdrawalPayout({
      auditorUserId: 'auditor-1', onchainTxHash: '0xwithdrawn', amount: 5_000n
    })).rejects.toMatchObject({ errorCode: 'CONFLICT' });

    expect(mockCreatePayout).not.toHaveBeenCalled();
  });

  it('requires an explicit payout fee instead of silently applying a financial default', async () => {
    mockFindBySource.mockResolvedValue(null);
    delete process.env.AUDITOR_PAYOUT_FEE_VND;

    await expect(createStakeWithdrawalPayout({
      auditorUserId: 'auditor-1', onchainTxHash: '0xwithdrawn', amount: 3_000_000n
    })).rejects.toThrow('AUDITOR_PAYOUT_FEE_VND');

    expect(mockCreatePayout).not.toHaveBeenCalled();
  });

  it('returns the existing payout without creating or enqueueing a duplicate', async () => {
    const existing = { payoutId: 'payout-existing' };
    mockFindBySource.mockResolvedValue(existing);

    await expect(createStakeWithdrawalPayout({
      auditorUserId: 'auditor-1', onchainTxHash: '0xwithdrawn', amount: 3_000_000n
    })).resolves.toEqual(existing);

    expect(mockCreatePayout).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('continues the original payout when a late Withdrawn event resolves its manual crash-window review', async () => {
    mockLinkWithdrawal.mockResolvedValue({ payoutId: 'payout-1', status: 'PENDING', onchainTxHash: '0xwithdrawn' });
    mockPromoteLock.mockResolvedValue({ walletLock: 'PAYOUT_IN_FLIGHT' });

    await expect(confirmStakeWithdrawalPayout('auditor-1', 'payout-1', '0xwithdrawn'))
      .resolves.toMatchObject({ payoutId: 'payout-1', onchainTxHash: '0xwithdrawn' });

    expect(mockPromoteLock).toHaveBeenCalledWith('auditor-1', 'payout-1');
    expect(mockEnqueue).toHaveBeenCalledWith('payout-1');
  });
});
