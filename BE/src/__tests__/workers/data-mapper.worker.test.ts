/**
 * Unit tests cho data-mapper.worker.ts.
 * Test cac ham exported: acquireDistributedLock, runDataMapperCycle, resetModuleState.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRedisSet = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const mockRedisGet = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const mockRedisDel = vi.hoisted(() => vi.fn<() => Promise<number>>());

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => ({
    set: mockRedisSet,
    get: mockRedisGet,
    del: mockRedisDel,
  })),
}));

vi.mock('../../repositories/unifiedTransactionRepository', () => ({
  buildPayosCorrelationId: vi.fn((orderCode: string) => `deposit:${orderCode}`),
  buildBlockchainCorrelationId: vi.fn((txHash: string) => `donation:${txHash.toLowerCase()}`),
  findUnifiedTransactionByCorrelationId: vi.fn().mockResolvedValue(null),
  upsertUnifiedTransactionByCorrelationId: vi.fn().mockResolvedValue({}),
  createUnifiedTransactionFromBlockchain: vi.fn().mockResolvedValue({}),
  createUnifiedTransactionFromPayos: vi.fn().mockResolvedValue({}),
  markChainTransactionReorged: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../models/depositModel', () => ({
  DepositTransactionModel: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  },
  DepositTransaction: {},
}));

vi.mock('../../models/donationModel', () => ({
  upsertDonationByTransactionHash: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/unified-timeline.service', () => ({
  invalidateUnifiedTimelineCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/unifiedTransactionModel', () => ({
  UnifiedTransactionModel: {
    find: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      }),
    }),
    updateOne: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    }),
    updateMany: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    }),
  },
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn(),
    Interface: vi.fn(),
  },
}));

import {
  resetModuleState,
  acquireDistributedLock,
  runDataMapperCycle,
} from '../../workers/data-mapper.worker';

beforeEach(() => {
  vi.clearAllMocks();
  resetModuleState();
});

afterEach(() => {
  resetModuleState();
});

// =========================================================
// resetModuleState
// =========================================================
describe('resetModuleState', () => {
  it('reset thanh cong ma khong throw exception', () => {
    expect(() => resetModuleState()).not.toThrow();
  });
});

// =========================================================
// acquireDistributedLock
// =========================================================
describe('acquireDistributedLock', () => {
  it('tra ve true khi redis chua san sang', async () => {
    const { getRedisClientIfReady } = await import('../../config/redis');
    vi.mocked(getRedisClientIfReady).mockReturnValue(null);

    const result = await acquireDistributedLock();

    expect(result).toBe(true);
  });

  it('tra ve false khi Redis throw loi de tranh duplicate processing', async () => {
    mockRedisSet.mockRejectedValue(new Error('Redis error'));

    const result = await acquireDistributedLock();

    expect(result).toBe(false);
  });
});

// =========================================================
// runDataMapperCycle
// =========================================================
describe('runDataMapperCycle', () => {
  beforeEach(() => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', '');
    vi.stubEnv('DONATION_RANKING_CONTRACT_ADDRESS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tra ve ket qua voi day du cac truong', async () => {
    const result = await runDataMapperCycle();

    expect(result).toHaveProperty('blockchainSynced');
    expect(result).toHaveProperty('payosSynced');
    expect(result).toHaveProperty('correlated');
    expect(result).toHaveProperty('reorged');
  });

  it('tra ve so lieu la number', async () => {
    const result = await runDataMapperCycle();

    expect(typeof result.blockchainSynced).toBe('number');
    expect(typeof result.payosSynced).toBe('number');
    expect(typeof result.correlated).toBe('number');
    expect(typeof result.reorged).toBe('number');
  });

  it('goi invalidateUnifiedTimelineCache sau khi sync xong', async () => {
    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).toHaveBeenCalled();
  });
});
