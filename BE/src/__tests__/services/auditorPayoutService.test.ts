import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditorPayout } from '../../models/auditorPayoutModel';

const mocks = vi.hoisted(() => ({
  contract: vi.fn(),
  cancelRewardPayout: vi.fn(),
  claimPayoutForBurn: vi.fn(),
  findPayout: vi.fn(),
  findUser: vi.fn(),
  provider: vi.fn(),
  releaseWalletLock: vi.fn(),
  reopenPayout: vi.fn(),
  updatePayout: vi.fn(),
  wallet: vi.fn()
}));

vi.mock('ethers', () => ({
  ethers: {
    Contract: mocks.contract,
    JsonRpcProvider: mocks.provider,
    Wallet: mocks.wallet
  }
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUser }));
vi.mock('../../models/auditorPayoutModel', () => ({
  cancelUnsubmittedAuditorRewardPayout: mocks.cancelRewardPayout,
  claimAuditorPayoutForBurn: mocks.claimPayoutForBurn,
  findAuditorPayoutById: mocks.findPayout,
  findAuditorPayoutByPayosTransferId: vi.fn(),
  markAuditorPayoutFailedIfTransferring: vi.fn(),
  reopenAuditorPayoutForManualBurn: mocks.reopenPayout,
  updateAuditorPayout: mocks.updatePayout
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({ releaseAuditorWalletLock: mocks.releaseWalletLock }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: vi.fn() }) }));

import {
  hasAuditorPayoutBalance,
  cancelAuditorRewardPayoutAfterManualReview,
  finalizeAuditorPayoutAfterPayosSuccess,
  retryAuditorPayoutBurnAfterManualReview
} from '../../services/auditorPayoutService';

/** Tạo payout tối thiểu hoàn chỉnh để test điều kiện số dư của lane chi trả Auditor. */
function createPayout(): AuditorPayout {
  const now = new Date();
  return {
    payoutId: 'payout-1',
    auditorUserId: 'auditor-1',
    payoutType: 'STAKE_WITHDRAWAL',
    sourceRefId: 'source-1',
    amountVnd: 100_000,
    feeVnd: 5_000,
    netAmountVnd: 95_000,
    bankSnapshot: {
      bankName: 'Vietcombank',
      bankCode: 'VCB',
      bankAccountNumber: '0123456789',
      accountHolderName: 'NGUYEN VAN A'
    },
    status: 'PENDING',
    payosTransferId: null,
    transferIdempotencyKey: 'payout:payout-1',
    onchainTxHash: '0xwithdrawn',
    burnTxHash: null,
    attemptNumber: 0,
    errorMessage: null,
    createdAt: now,
    updatedAt: now
  };
}

describe('auditor payout service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'http://rpc.example.test';
    process.env.CHARITY_TOKEN_CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000c3';
    delete process.env.BACKEND_MINTER_PRIVATE_KEY;
    mocks.findUser.mockResolvedValue({ walletAddress: '0x00000000000000000000000000000000000000b2' });
    mocks.contract.mockReturnValue({ balanceOf: vi.fn().mockResolvedValue(100_000n) });
  });

  afterEach(() => {
    delete process.env.BLOCKCHAIN_RPC_URL;
    delete process.env.CHARITY_TOKEN_CONTRACT_ADDRESS;
    delete process.env.BACKEND_MINTER_PRIVATE_KEY;
  });

  it('checks payout balance through a read-only provider without requiring the minter private key', async () => {
    await expect(hasAuditorPayoutBalance(createPayout())).resolves.toBe(true);

    expect(mocks.provider).toHaveBeenCalledWith('http://rpc.example.test');
    expect(mocks.wallet).not.toHaveBeenCalled();
  });

  it('burns the exact gross token amount only after PayOS reports a successful payout', async () => {
    process.env.BACKEND_MINTER_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const payout = { ...createPayout(), status: 'TRANSFERRING' as const };
    const burnForDisbursement = vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({ hash: '0xburned', status: 1 }) });
    mocks.findPayout.mockResolvedValue(payout);
    mocks.claimPayoutForBurn.mockResolvedValue(payout);
    mocks.contract.mockReturnValue({ balanceOf: vi.fn().mockResolvedValue(100_000n), burnForDisbursement });

    await finalizeAuditorPayoutAfterPayosSuccess(payout.payoutId);

    expect(burnForDisbursement).toHaveBeenCalledWith(
      '0x00000000000000000000000000000000000000b2',
      100_000n,
      'AUDITOR_UNSTAKE:payout-1'
    );
    expect(mocks.updatePayout).toHaveBeenCalledWith('payout-1', {
      status: 'BURNED', burnTxHash: '0xburned', errorMessage: null
    });
    expect(mocks.releaseWalletLock).toHaveBeenCalledWith('auditor-1', 'payout-1');
  });

  it('rejects a manual burn retry unless the payout is still eligible and the PayOS transfer ID matches', async () => {
    mocks.reopenPayout.mockResolvedValue(null);

    await expect(retryAuditorPayoutBurnAfterManualReview('payout-1', 'payos-transfer-1'))
      .rejects.toMatchObject({ errorCode: 'CONFLICT' });
  });

  it('cancels only a safe reward payout and releases its exact wallet lock', async () => {
    mocks.cancelRewardPayout.mockResolvedValue({ ...createPayout(), payoutType: 'REWARD', onchainTxHash: null, status: 'CANCELLED' });

    await expect(cancelAuditorRewardPayoutAfterManualReview('payout-1', 'Auditor đã dùng DCT để đặt cọc.')).resolves.toBeUndefined();

    expect(mocks.releaseWalletLock).toHaveBeenCalledWith('auditor-1', 'payout-1', 'PAYOUT_IN_FLIGHT');
  });

  it('retries releasing a lock after a prior cancellation committed but the first release failed', async () => {
    mocks.cancelRewardPayout.mockResolvedValue(null);
    mocks.findPayout.mockResolvedValue({ ...createPayout(), payoutType: 'REWARD', onchainTxHash: null, status: 'CANCELLED' });

    await expect(cancelAuditorRewardPayoutAfterManualReview('payout-1', 'Retry nhả khóa sau lỗi tạm thời.')).resolves.toBeUndefined();

    expect(mocks.releaseWalletLock).toHaveBeenCalledWith('auditor-1', 'payout-1', 'PAYOUT_IN_FLIGHT');
  });
});
