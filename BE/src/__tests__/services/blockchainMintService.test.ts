import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contract: vi.fn(),
  jsonRpcProvider: vi.fn(),
  wallet: vi.fn(),
  mintFromBackend: vi.fn(),
  recordBlockchainTransaction: vi.fn()
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mocks.jsonRpcProvider,
    Wallet: mocks.wallet,
    Contract: mocks.contract
  }
}));

vi.mock('../../utils/blockchainMetrics', () => ({
  recordBlockchainTransaction: mocks.recordBlockchainTransaction
}));

import { mintTokenForDeposit } from '../../services/blockchainMintService';

describe('mintTokenForDeposit blockchain metrics and receipt handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'http://localhost:8545');
    vi.stubEnv('BACKEND_MINTER_PRIVATE_KEY', '0xprivate-key');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x0000000000000000000000000000000000000001');
    mocks.jsonRpcProvider.mockReturnValue({});
    mocks.wallet.mockReturnValue({});
    mocks.contract.mockReturnValue({ mintFromBackend: mocks.mintFromBackend });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records the mint_deposit operation and returns the hash for a successful receipt', async () => {
    const receipt = { hash: '0xmint-success', status: 1, gasUsed: 123_456n };
    mocks.mintFromBackend.mockResolvedValue({
      wait: vi.fn().mockResolvedValue(receipt)
    });

    await expect(mintTokenForDeposit('0x0000000000000000000000000000000000000002', 10, 'ORDER-1'))
      .resolves.toEqual({ transactionHash: receipt.hash });

    expect(mocks.recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'mint_deposit',
      receipt
    }));
  });

  it('records a reverted receipt as failed and rejects instead of returning success', async () => {
    const receipt = { hash: '0xmint-reverted', status: 0, gasUsed: 123_456n };
    mocks.mintFromBackend.mockResolvedValue({
      wait: vi.fn().mockResolvedValue(receipt)
    });

    await expect(mintTokenForDeposit('0x0000000000000000000000000000000000000002', 10, 'ORDER-2'))
      .rejects.toThrow('revert on-chain');

    expect(mocks.recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'mint_deposit',
      receipt
    }));
  });

  it('rejects when the provider returns no receipt without recording a transaction', async () => {
    mocks.mintFromBackend.mockResolvedValue({
      wait: vi.fn().mockResolvedValue(null)
    });

    await expect(mintTokenForDeposit('0x0000000000000000000000000000000000000002', 10, 'ORDER-3'))
      .rejects.toThrow('Không lấy được transaction hash');
    expect(mocks.recordBlockchainTransaction).not.toHaveBeenCalled();
  });
});
