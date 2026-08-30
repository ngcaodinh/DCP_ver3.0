import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jsonRpcProvider: vi.fn()
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mocks.jsonRpcProvider
  }
}));
vi.mock('../../config/blockchainRpc', () => ({
  getBlockchainRpcFallbackUrl: () => process.env.AUDITOR_STAKING_RPC_FALLBACK_URL ?? '',
  getBlockchainRpcUrl: () => 'https://rpc.example.test'
}));
vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}));

import {
  getReadOnlyAuditorStakingFallbackProvider,
  getReadOnlyAuditorStakingProvider
} from '../../config/auditorStakingContract';

describe('auditorStakingContract RPC provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('giới hạn JSON-RPC batch ở mức provider cho phép', () => {
    const provider = {};
    mocks.jsonRpcProvider.mockReturnValue(provider);

    expect(getReadOnlyAuditorStakingProvider()).toBe(provider);
    expect(mocks.jsonRpcProvider).toHaveBeenCalledWith(
      'https://rpc.example.test',
      undefined,
      { batchMaxCount: 1 }
    );
  });

  it('không tạo fallback provider khi endpoint dự phòng chưa được cấu hình', () => {
    vi.stubEnv('AUDITOR_STAKING_RPC_FALLBACK_URL', '');

    expect(getReadOnlyAuditorStakingFallbackProvider()).toBeNull();
  });

  it('khởi tạo fallback provider khi endpoint dự phòng được cấu hình', () => {
    const fallbackProvider = {};
    vi.stubEnv('AUDITOR_STAKING_RPC_FALLBACK_URL', 'https://fallback-rpc.example.test');
    mocks.jsonRpcProvider.mockReturnValue(fallbackProvider);

    expect(getReadOnlyAuditorStakingFallbackProvider()).toBe(fallbackProvider);
    expect(mocks.jsonRpcProvider).toHaveBeenCalledWith(
      'https://fallback-rpc.example.test',
      undefined,
      { batchMaxCount: 1 }
    );
  });
});
