import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditorPayout } from '../../models/auditorPayoutModel';

const mocks = vi.hoisted(() => ({
  contract: vi.fn(),
  findUser: vi.fn(),
  provider: vi.fn(),
  reopenPayout: vi.fn(),
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
  claimAuditorPayoutForBurn: vi.fn(),
  findAuditorPayoutById: vi.fn(),
  findAuditorPayoutByPayosTransferId: vi.fn(),
  markAuditorPayoutFailedIfTransferring: vi.fn(),
  reopenAuditorPayoutForManualBurn: mocks.reopenPayout,
  updateAuditorPayout: vi.fn()
}));
vi.mock('../../models/auditorStakeGuardModel', () => ({ releaseAuditorWalletLock: vi.fn() }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: vi.fn() }) }));

import {
  hasAuditorPayoutBalance,
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

  it('rejects a manual burn retry unless the payout is still eligible and the PayOS transfer ID matches', async () => {
    mocks.reopenPayout.mockResolvedValue(null);

    await expect(retryAuditorPayoutBurnAfterManualReview('payout-1', 'payos-transfer-1'))
      .rejects.toMatchObject({ errorCode: 'CONFLICT' });
  });
});
