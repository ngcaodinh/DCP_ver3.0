import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jsonRpcProvider: vi.fn()
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mocks.jsonRpcProvider
  }
}));
vi.mock('../../config/blockchainRpc', () => ({
  getBlockchainRpcUrl: () => 'https://rpc.example.test'
}));
vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}));

import { getReadOnlyAuditorStakingProvider } from '../../config/auditorStakingContract';

describe('auditorStakingContract RPC provider', () => {
  it('giới hạn JSON-RPC batch ở mức provider cho phép', () => {
    const provider = {};
    mocks.jsonRpcProvider.mockReturnValue(provider);

    expect(getReadOnlyAuditorStakingProvider()).toBe(provider);
    expect(mocks.jsonRpcProvider).toHaveBeenCalledWith(
      'https://rpc.example.test',
      undefined,
      { batchMaxCount: 3 }
    );
  });
});
