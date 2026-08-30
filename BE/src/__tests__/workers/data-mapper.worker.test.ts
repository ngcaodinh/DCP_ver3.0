/**
 * Unit tests cho data-mapper.worker.ts.
 * Test cac ham exported: acquireDistributedLock, runDataMapperCycle, resetModuleState.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRedisSet = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const mockRedisGet = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const mockRedisDel = vi.hoisted(() => vi.fn<() => Promise<number>>());
const mockRpcGetBlockNumber = vi.hoisted(() => vi.fn<() => Promise<number>>());
const mockRpcGetLogs = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const mockRpcGetNetwork = vi.hoisted(() => vi.fn<() => Promise<{ chainId: bigint }>>());
const mockFallbackGetLogs = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const mockFallbackGetNetwork = vi.hoisted(() => vi.fn<() => Promise<{ chainId: bigint }>>());
const mockInterfaceGetEvent = vi.hoisted(() => vi.fn());
const mockInterfaceParseLog = vi.hoisted(() => vi.fn());
const mockCreateUnifiedTransactionFromBlockchain = vi.hoisted(() => vi.fn());
const mockUpsertDonationByTransactionHash = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
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
  createUnifiedTransactionFromBlockchain: mockCreateUnifiedTransactionFromBlockchain,
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
  upsertDonationByTransactionHash: mockUpsertDonationByTransactionHash,
}));

vi.mock('../../services/unified-timeline.service', () => ({
  invalidateUnifiedTimelineCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/verification.service', () => ({
  invalidateVerificationCache: vi.fn().mockResolvedValue(undefined),
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
    JsonRpcProvider: vi.fn((rpcUrl: string) => rpcUrl === 'https://fallback-rpc.example.com'
      ? { getLogs: mockFallbackGetLogs, getNetwork: mockFallbackGetNetwork }
      : { getBlockNumber: mockRpcGetBlockNumber, getLogs: mockRpcGetLogs, getNetwork: mockRpcGetNetwork }),
    Interface: vi.fn(() => ({
      getEvent: mockInterfaceGetEvent,
      parseLog: mockInterfaceParseLog,
    })),
  },
}));

import { getRedisClientIfReady } from '../../config/redis';
import { getRequestContext } from '../../config/requestContext';
import { DepositTransactionModel } from '../../models/depositModel';
import {
  findUnifiedTransactionByCorrelationId,
  upsertUnifiedTransactionByCorrelationId,
} from '../../repositories/unifiedTransactionRepository';
import type { UnifiedTransaction } from '../../models/unifiedTransactionModel';

import {
  resetModuleState,
  acquireDistributedLock,
  runDataMapperCycle,
} from '../../workers/data-mapper.worker';

/** Tạo unified PayOS record sẵn có để kiểm tra nhánh đồng bộ idempotent. */
function makeExistingPayosRecord(overrides: Partial<UnifiedTransaction> = {}): UnifiedTransaction {
  const timestamp = new Date('2026-08-10T10:00:00.000Z');
  return {
    utxId: 'utx-payos-001',
    correlationId: 'deposit:1001',
    projectId: '',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    amountVnd: 100000,
    eventType: 'DEPOSIT',
    eventTimestamp: timestamp,
    source: 'PAYOS',
    chainStatus: 'PENDING',
    chainTxHash: null,
    chainBlockNumber: null,
    payosStatus: 'PAYMENT_CONFIRMED',
    payosOrderCode: '1001',
    payosTransactionId: null,
    payosRecordId: 'deposit-001',
    blockchainRecordId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** Tạo chain query trống cho các test không cần PayOS deposit. */
function makeEmptyDepositQuery() {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
}

/** Tạo lỗi RPC code 19 để kiểm tra DataMapper fail over thay vì bỏ dở checkpoint ngay lập tức. */
function createTemporaryGetLogsError(): Error & { error: { code: number; message: string } } {
  return Object.assign(
    new Error('could not coalesce error'),
    { error: { code: 19, message: 'Temporary internal error. Please retry.' } }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModuleState();
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGet.mockResolvedValue(null);
  mockRedisDel.mockResolvedValue(1);
  mockRpcGetBlockNumber.mockResolvedValue(0);
  mockRpcGetLogs.mockResolvedValue([]);
  mockRpcGetNetwork.mockResolvedValue({ chainId: 31_337n });
  mockFallbackGetLogs.mockResolvedValue([]);
  mockFallbackGetNetwork.mockResolvedValue({ chainId: 31_337n });
  mockInterfaceGetEvent.mockReturnValue({ topicHash: '0xDonationReceived' });
  mockInterfaceParseLog.mockReturnValue(null);
  mockCreateUnifiedTransactionFromBlockchain.mockResolvedValue({});
  mockUpsertDonationByTransactionHash.mockResolvedValue({});
  vi.mocked(findUnifiedTransactionByCorrelationId).mockResolvedValue(null);
  vi.mocked(upsertUnifiedTransactionByCorrelationId).mockResolvedValue({} as never);
  vi.mocked(DepositTransactionModel.find).mockReturnValue(makeEmptyDepositQuery() as never);
  vi.mocked(getRedisClientIfReady).mockReturnValue({
    set: mockRedisSet,
    get: mockRedisGet,
    del: mockRedisDel,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
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
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'http://localhost:8545');
    vi.stubEnv('DONATION_RANKING_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
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

  it('ghi log trong worker context co run ID on dinh cho ca chu ky', async () => {
    mockLoggerInfo.mockReset();
    const observedContexts: Array<ReturnType<typeof getRequestContext>> = [];
    mockLoggerInfo.mockImplementation(() => {
      observedContexts.push(getRequestContext());
    });

    await runDataMapperCycle();

    const workerContext = observedContexts.find(context => Boolean(context?.workerRunId));
    expect(workerContext).toMatchObject({
      requestId: expect.stringMatching(/^data-mapper:/),
      userId: null,
      workerName: 'data-mapper',
      workerRunId: expect.stringMatching(/^data-mapper:/)
    });
    expect(workerContext?.requestId).toBe(workerContext?.workerRunId);
  });

  it('tra ve so lieu la number', async () => {
    const result = await runDataMapperCycle();

    expect(typeof result.blockchainSynced).toBe('number');
    expect(typeof result.payosSynced).toBe('number');
    expect(typeof result.correlated).toBe('number');
    expect(typeof result.reorged).toBe('number');
  });

  it('không invalidate cache khi cycle không có dữ liệu thay đổi', async () => {
    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).not.toHaveBeenCalled();
    expect(invalidateVerificationCache).not.toHaveBeenCalled();
  });

  it('không invalidate cache khi blockchain event malformed không được sync', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockResolvedValue([{
      topics: ['0xmalformed'],
      data: '0x',
      transactionHash: '0xtransaction',
      blockNumber: 1
    }]);

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).not.toHaveBeenCalled();
    expect(invalidateVerificationCache).not.toHaveBeenCalled();
  });

  it('invalidate cache nhưng không advance checkpoint khi unified transaction lỗi', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockResolvedValue([{
      topics: ['0xDonationReceived'],
      data: '0xencoded',
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      blockNumber: 1
    }]);
    mockInterfaceParseLog.mockReturnValue({
      args: {
        donor: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        projectId: 'project-1',
        amount: 1000,
        timestamp: 1,
        isAnonymous: false
      }
    });
    mockCreateUnifiedTransactionFromBlockchain.mockRejectedValue(new Error('unified unavailable'));

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).toHaveBeenCalledWith('project-1');
    expect(invalidateVerificationCache).toHaveBeenCalledWith('project-1');
    expect(mockRedisSet).not.toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });

  it('invalidate cache nhưng không advance checkpoint khi donation record lỗi', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockResolvedValue([{
      topics: ['0xDonationReceived'],
      data: '0xencoded',
      transactionHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      blockNumber: 1
    }]);
    mockInterfaceParseLog.mockReturnValue({
      args: {
        donor: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        projectId: 'project-1',
        amount: 1000,
        timestamp: 1,
        isAnonymous: false
      }
    });
    mockUpsertDonationByTransactionHash.mockRejectedValue(new Error('donation unavailable'));

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).toHaveBeenCalledWith('project-1');
    expect(invalidateVerificationCache).toHaveBeenCalledWith('project-1');
    expect(mockRedisSet).not.toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });

  it('chỉ invalidate timeline khi cycle sync được PayOS record standalone mới', async () => {
    const paymentConfirmedAt = new Date('2026-08-10T10:00:00.000Z');
    vi.mocked(DepositTransactionModel.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([{
              id: 'deposit-001',
              orderCode: '1001',
              status: 'PAYMENT_CONFIRMED',
              walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
              amountVnd: 100000,
              paymentConfirmedAt,
              updatedAt: paymentConfirmedAt,
              payosTransactionId: null
            }])
          })
        })
      })
    } as never);

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).toHaveBeenCalledOnce();
    expect(invalidateVerificationCache).not.toHaveBeenCalled();
  });

  it('không invalidate timeline khi PayOS record được đọc lại mà projection không đổi', async () => {
    const paymentConfirmedAt = new Date('2026-08-10T10:00:00.000Z');
    vi.mocked(DepositTransactionModel.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([{
              id: 'deposit-001',
              orderCode: '1001',
              status: 'PAYMENT_CONFIRMED',
              walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
              amountVnd: 100000,
              paymentConfirmedAt,
              updatedAt: paymentConfirmedAt,
              payosTransactionId: null
            }])
          })
        })
      })
    } as never);
    vi.mocked(findUnifiedTransactionByCorrelationId).mockResolvedValue(makeExistingPayosRecord());

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    const result = await runDataMapperCycle();

    expect(result.payosSynced).toBe(1);
    expect(upsertUnifiedTransactionByCorrelationId).not.toHaveBeenCalled();
    expect(invalidateUnifiedTimelineCache).not.toHaveBeenCalled();
    expect(invalidateVerificationCache).not.toHaveBeenCalled();
  });

  it('invalidate timeline khi PayOS projection đang lưu thay đổi', async () => {
    const paymentConfirmedAt = new Date('2026-08-10T10:00:00.000Z');
    vi.mocked(DepositTransactionModel.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([{
              id: 'deposit-001',
              orderCode: '1001',
              status: 'PAYMENT_CONFIRMED',
              walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
              amountVnd: 100000,
              paymentConfirmedAt,
              updatedAt: paymentConfirmedAt,
              payosTransactionId: 'payos-tx-001'
            }])
          })
        })
      })
    } as never);
    vi.mocked(findUnifiedTransactionByCorrelationId).mockResolvedValue(makeExistingPayosRecord());

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    const result = await runDataMapperCycle();

    expect(result.payosSynced).toBe(1);
    expect(upsertUnifiedTransactionByCorrelationId).toHaveBeenCalledWith('deposit:1001', {
      payosStatus: 'PAYMENT_CONFIRMED',
      payosOrderCode: '1001',
      payosTransactionId: 'payos-tx-001',
      payosRecordId: 'deposit-001'
    });
    expect(invalidateUnifiedTimelineCache).toHaveBeenCalledOnce();
    expect(invalidateVerificationCache).not.toHaveBeenCalled();
  });

  it('giữ checkpoint trước chunk khi getLogs thất bại để lần sau retry', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockRejectedValue(new Error('RPC timeout'));

    await runDataMapperCycle();

    expect(mockUpsertDonationByTransactionHash).not.toHaveBeenCalled();
    expect(mockCreateUnifiedTransactionFromBlockchain).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });

  it('dùng fallback RPC cùng chain sau khi primary eth_getLogs hết retry tạm thời', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BLOCKCHAIN_RPC_FALLBACK_URL', 'https://fallback-rpc.example.com');
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockRejectedValue(createTemporaryGetLogsError());
    mockFallbackGetLogs.mockResolvedValue([]);

    const synchronization = runDataMapperCycle();
    await vi.runAllTimersAsync();
    await synchronization;

    expect(mockRpcGetLogs).toHaveBeenCalledTimes(3);
    expect(mockFallbackGetNetwork).toHaveBeenCalledOnce();
    expect(mockFallbackGetLogs).toHaveBeenCalledOnce();
    expect(mockRedisSet).toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });

  it('checkpoint hỏng được coi là chưa sync để không làm worker dừng im lặng', async () => {
    mockRedisGet.mockResolvedValue('invalid-block-checkpoint');
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockResolvedValue([]);

    await runDataMapperCycle();

    expect(mockRpcGetLogs).toHaveBeenCalledWith(expect.objectContaining({
      fromBlock: 1,
      toBlock: 1
    }));
    expect(mockRedisSet).toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });

  it('chia eth_getLogs thành các chunk 250 block để không làm quá tải public RPC', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(251);
    mockRpcGetLogs.mockResolvedValue([]);

    await runDataMapperCycle();

    expect(mockRpcGetLogs).toHaveBeenCalledTimes(2);
    expect(mockRpcGetLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({
      fromBlock: 1,
      toBlock: 250
    }));
    expect(mockRpcGetLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({
      fromBlock: 251,
      toBlock: 251
    }));
  });

  it('invalidate summary theo đúng các project có blockchain event mới', async () => {
    mockRpcGetBlockNumber.mockResolvedValue(1);
    mockRpcGetLogs.mockResolvedValue([
      {
        topics: ['0xDonationReceived'],
        data: 'project-a',
        transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        blockNumber: 1
      },
      {
        topics: ['0xDonationReceived'],
        data: 'project-b',
        transactionHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        blockNumber: 1
      }
    ]);
    mockInterfaceParseLog.mockImplementation(({ data }: { data: string }) => ({
      args: {
        donor: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        projectId: data,
        amount: 1000,
        timestamp: 1,
        isAnonymous: false
      }
    }));

    const { invalidateUnifiedTimelineCache } = await import('../../services/unified-timeline.service');
    const { invalidateVerificationCache } = await import('../../services/verification.service');

    await runDataMapperCycle();

    expect(invalidateUnifiedTimelineCache).toHaveBeenCalledTimes(2);
    expect(invalidateUnifiedTimelineCache).toHaveBeenNthCalledWith(1, 'project-a');
    expect(invalidateUnifiedTimelineCache).toHaveBeenNthCalledWith(2, 'project-b');
    expect(invalidateVerificationCache).toHaveBeenCalledTimes(2);
    expect(invalidateVerificationCache).toHaveBeenNthCalledWith(1, 'project-a');
    expect(invalidateVerificationCache).toHaveBeenNthCalledWith(2, 'project-b');
    expect(mockRedisSet).toHaveBeenCalledWith('data_mapper:last_synced_block', '1');
  });
});
