/**
 * Unit tests cho verification.service — kiểm tra nguồn số liệu, cache và contract D3.
 * Các dependency MongoDB/Redis được mock để test deterministic và không dùng dữ liệu thật.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindUnifiedTxByCorrelationId = vi.fn();
const mockAggregateSummaryByProjectId = vi.fn();
const mockAggregateDisbursementsByProjectId = vi.fn();
const mockFindCompletedDisbursementAmountsByProjectId = vi.fn();
const mockGetRedisClientIfReady = vi.fn();

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: () => mockGetRedisClientIfReady()
}));

vi.mock('../../repositories/unifiedTransactionRepository', () => ({
  findUnifiedTransactionByCorrelationId: (...args: unknown[]) => mockFindUnifiedTxByCorrelationId(...args),
  aggregateSummaryByProjectId: (...args: unknown[]) => mockAggregateSummaryByProjectId(...args)
}));

vi.mock('../../models/disbursementModel', () => ({
  MAX_COMPLETED_DISBURSEMENT_AMOUNTS: 100,
  getCompletedDisbursementSummaryByProjectId: (...args: unknown[]) => mockAggregateDisbursementsByProjectId(...args),
  findCompletedDisbursementAmountsByProjectId: (...args: unknown[]) => mockFindCompletedDisbursementAmountsByProjectId(...args)
}));

vi.mock('../../models/disbursementTransferModel', () => ({
  findTransferLogsByRequestId: vi.fn().mockResolvedValue([])
}));

import {
  getProjectSummary,
  invalidateVerificationCache,
  resetCacheMetrics,
  verifyTransaction
} from '../../services/verification.service';
import { signCachePayload } from '../../utils/cacheIntegrity';

type RedisMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

/** Tạo số liệu aggregate mặc định cho một dự án không có giao dịch. */
function createEmptySummaryStats(): {
  totalRaisedVnd: number;
  totalTransactions: number;
  uniqueDonorCount: number;
  excludedReorgedVnd: number;
  excludedReorgedCount: number;
} {
  return {
    totalRaisedVnd: 0,
    totalTransactions: 0,
    uniqueDonorCount: 0,
    excludedReorgedVnd: 0,
    excludedReorgedCount: 0
  };
}

/** Tạo unified transaction tối thiểu để test các nhánh verify. */
function createTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    utxId: 'utx-001',
    correlationId: 'donation:0xabc',
    projectId: 'project-001',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    amountVnd: 50000,
    eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
    source: 'BLOCKCHAIN',
    chainStatus: 'CONFIRMED',
    chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    chainBlockNumber: 12345678,
    payosStatus: null,
    payosOrderCode: null,
    eventType: 'DONATION',
    ...overrides
  };
}

/** Tạo Redis mock có đủ thao tác cần cho summary cache. */
function createRedisMock(overrides: Partial<RedisMock> = {}): RedisMock {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides
  };
}

describe('verification.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClientIfReady.mockReturnValue(null);
    mockAggregateSummaryByProjectId.mockResolvedValue(createEmptySummaryStats());
    mockAggregateDisbursementsByProjectId.mockResolvedValue({
      totalCompletedAmount: 0,
      completedCount: 0
    });
    mockFindCompletedDisbursementAmountsByProjectId.mockResolvedValue([]);
    resetCacheMetrics();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('verifyTransaction', () => {
    it('trả found=false và project-level null khi không tìm thấy giao dịch', async () => {
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(null);

      const result = await verifyTransaction('missing:1');

      expect(result).toMatchObject({
        found: false,
        correlationId: 'missing:1',
        projectTotalRaised: null,
        projectTotalDisbursed: null,
        projectDisbursementCount: null,
        disbursedRatioBps: null
      });
    });

    it('dùng summary chung để trả tỷ lệ theo tổng huy động toàn dự án', async () => {
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(createTransaction({
        correlationId: 'deposit:ratio-1',
        projectId: 'project-ratio'
      }));
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 12000000,
        totalTransactions: 3,
        uniqueDonorCount: 2,
        excludedReorgedVnd: 0,
        excludedReorgedCount: 0
      });
      mockAggregateDisbursementsByProjectId.mockResolvedValue({
        totalCompletedAmount: 8000000,
        completedCount: 2
      });

      const result = await verifyTransaction('deposit:ratio-1');

      expect(result).toMatchObject({
        projectTotalRaised: 12000000,
        projectTotalDisbursed: 8000000,
        projectDisbursementCount: 2,
        disbursedRatioBps: 6667,
        cached: false,
        fallbackMode: true
      });
      expect(mockAggregateSummaryByProjectId).toHaveBeenCalledWith('project-ratio');
    });

    it('trả nguyên chain tx hash 66 ký tự, không mask', async () => {
      const transaction = createTransaction();
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(transaction);

      const result = await verifyTransaction('donation:0xabc');

      expect(result?.chain?.txHash).toBe(transaction.chainTxHash);
      expect(result?.chain?.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result?.chain?.txHash).not.toContain('...');
    });

    it('bỏ qua summary khi record DEPOSIT không có projectId', async () => {
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(createTransaction({
        correlationId: 'deposit:standalone',
        projectId: '',
        source: 'PAYOS',
        eventType: 'DEPOSIT',
        chainTxHash: null,
        chainBlockNumber: null,
        payosOrderCode: 'standalone'
      }));

      const result = await verifyTransaction('deposit:standalone');

      expect(result).toMatchObject({
        projectTotalRaised: null,
        projectTotalDisbursed: null,
        projectDisbursementCount: null,
        disbursedRatioBps: null,
        cached: false,
        fallbackMode: false
      });
      expect(mockAggregateSummaryByProjectId).not.toHaveBeenCalled();
    });

    it('trả null disbursedRatioBps khi summary có tổng huy động bằng 0', async () => {
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(createTransaction({
        correlationId: 'donation:zero-raised',
        projectId: 'project-zero-raised'
      }));

      const result = await verifyTransaction('donation:zero-raised');

      expect(result?.disbursedRatioBps).toBeNull();
    });
  });

  describe('getProjectSummary', () => {
    it('trả zero-value an toàn cho dự án rỗng', async () => {
      const result = await getProjectSummary('project-empty');

      expect(result).toMatchObject({
        totalRaised: 0,
        totalDisbursed: 0,
        remaining: 0,
        donorCount: 0,
        transactionCount: 0,
        disbursementCount: 0,
        disbursedAmounts: [],
        excludedReorgedVnd: 0,
        excludedReorgedCount: 0,
        overDisbursed: false,
        fallbackMode: true
      });
    });

    it('dùng donor unique và tổng giải ngân toàn bộ khi amounts chỉ giới hạn 100', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 1000000,
        totalTransactions: 3,
        uniqueDonorCount: 2,
        excludedReorgedVnd: 50000,
        excludedReorgedCount: 1
      });
      mockAggregateDisbursementsByProjectId.mockResolvedValue({
        totalCompletedAmount: 150000,
        completedCount: 150
      });
      mockFindCompletedDisbursementAmountsByProjectId.mockResolvedValue(
        Array.from({ length: 100 }, (_, index) => 1000 + index)
      );

      const result = await getProjectSummary('project-large');

      expect(result).toMatchObject({
        donorCount: 2,
        transactionCount: 3,
        totalDisbursed: 150000,
        disbursementCount: 150,
        excludedReorgedVnd: 50000,
        excludedReorgedCount: 1
      });
      expect(result.disbursedAmounts).toHaveLength(100);
      expect(mockFindCompletedDisbursementAmountsByProjectId)
        .toHaveBeenCalledWith('project-large', 100);
    });

    it('giữ remaining bằng 0 và bật overDisbursed khi giải ngân vượt huy động', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 100000
      });
      mockAggregateDisbursementsByProjectId.mockResolvedValue({
        totalCompletedAmount: 200000,
        completedCount: 2
      });

      const result = await getProjectSummary('project-over');

      expect(result.remaining).toBe(0);
      expect(result.overDisbursed).toBe(true);
    });
  });

  describe('summary cache integrity and fallback', () => {
    it('cache Redis hợp lệ trả cached=true và không query lại database', async () => {
      const redis = createRedisMock();
      const cachedSummary = {
        projectId: 'project-cache-valid',
        totalRaised: 100000,
        totalDisbursed: 50000,
        remaining: 50000,
        donorCount: 1,
        transactionCount: 1,
        disbursementCount: 1,
        disbursedAmounts: [50000],
        excludedReorgedVnd: 0,
        excludedReorgedCount: 0,
        overDisbursed: false,
        cached: false,
        fallbackMode: false
      };
      vi.mocked(redis.get).mockResolvedValue(signCachePayload(
        JSON.stringify(cachedSummary),
        'transparency:summary:project-cache-valid'
      ));
      mockGetRedisClientIfReady.mockReturnValue(redis);

      const result = await getProjectSummary('project-cache-valid');

      expect(result).toMatchObject({ cached: true, fallbackMode: false, totalRaised: 100000 });
      expect(mockAggregateSummaryByProjectId).not.toHaveBeenCalled();
    });

    it('payload bị sửa bị coi là cache miss và tính lại từ database', async () => {
      const redis = createRedisMock();
      const original = JSON.stringify({
        projectId: 'project-cache-tamper',
        totalRaised: 100000,
        totalDisbursed: 1,
        remaining: 99999,
        donorCount: 1,
        transactionCount: 1,
        disbursementCount: 1,
        disbursedAmounts: [1],
        excludedReorgedVnd: 0,
        excludedReorgedCount: 0,
        overDisbursed: false,
        cached: false,
        fallbackMode: false
      });
      const tampered = signCachePayload(
        original,
        'transparency:summary:project-cache-tamper'
      ).replace('100000', '999999');
      vi.mocked(redis.get).mockResolvedValue(tampered);
      mockGetRedisClientIfReady.mockReturnValue(redis);
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 500000
      });

      const result = await getProjectSummary('project-cache-tamper');

      expect(result.totalRaised).toBe(500000);
      expect(result.totalRaised).not.toBe(999999);
      expect(redis.del).toHaveBeenCalledWith('transparency:summary:project-cache-tamper');
    });

    it('payload có HMAC hợp lệ nhưng JSON hỏng bị coi là cache miss', async () => {
      const redis = createRedisMock({
        get: vi.fn().mockResolvedValue(signCachePayload(
          '{invalid-json',
          'transparency:summary:project-cache-invalid-json'
        ))
      });
      mockGetRedisClientIfReady.mockReturnValue(redis);
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 321
      });

      const result = await getProjectSummary('project-cache-invalid-json');

      expect(result.totalRaised).toBe(321);
      expect(redis.del).toHaveBeenCalledWith('transparency:summary:project-cache-invalid-json');
    });

    it('payload có HMAC hợp lệ nhưng thiếu field schema bị coi là cache miss', async () => {
      const redis = createRedisMock({
        get: vi.fn().mockResolvedValue(signCachePayload(JSON.stringify({
          projectId: 'project-cache-invalid-schema',
          totalRaised: 999999
        }), 'transparency:summary:project-cache-invalid-schema'))
      });
      mockGetRedisClientIfReady.mockReturnValue(redis);
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 654
      });

      const result = await getProjectSummary('project-cache-invalid-schema');

      expect(result.totalRaised).toBe(654);
      expect(redis.del).toHaveBeenCalledWith('transparency:summary:project-cache-invalid-schema');
    });

    it('không cho replay payload HMAC của project khác sang cache key hiện tại', async () => {
      const redis = createRedisMock({
        get: vi.fn().mockResolvedValue(signCachePayload(JSON.stringify({
          projectId: 'project-cache-source',
          totalRaised: 999999,
          totalDisbursed: 0,
          remaining: 999999,
          donorCount: 1,
          transactionCount: 1,
          disbursementCount: 0,
          disbursedAmounts: [],
          excludedReorgedVnd: 0,
          excludedReorgedCount: 0,
          overDisbursed: false,
          cached: false,
          fallbackMode: false
        }), 'transparency:summary:project-cache-source'))
      });
      mockGetRedisClientIfReady.mockReturnValue(redis);

      const result = await getProjectSummary('project-cache-target');

      expect(result.totalRaised).toBe(0);
      expect(redis.del).toHaveBeenCalledWith('transparency:summary:project-cache-target');
    });

    it('entry cache cũ chưa ký bị coi là miss và được ghi lại có HMAC', async () => {
      const redis = createRedisMock({
        get: vi.fn().mockResolvedValue(JSON.stringify({ totalRaised: 999999 }))
      });
      mockGetRedisClientIfReady.mockReturnValue(redis);
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 500000
      });

      const result = await getProjectSummary('project-cache-legacy');

      expect(result.totalRaised).toBe(500000);
      const setPayload = vi.mocked(redis.set).mock.calls[0]?.[1];
      expect(setPayload).toEqual(expect.stringContaining('.'));
    });

    it('Redis không khả dụng thì fallbackMode=true', async () => {
      const result = await getProjectSummary('project-fallback');

      expect(result.fallbackMode).toBe(true);
    });

    it('thiếu HMAC key production không làm hỏng response khi ghi cache', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('CACHE_HMAC_KEY', '');
      vi.stubEnv('JWT_SECRET', '');

      const result = await getProjectSummary('project-cache-key-missing');

      expect(result.totalRaised).toBe(0);
      expect(result.fallbackMode).toBe(true);
    });

    it('đọc lại in-memory fallback vẫn verify HMAC và đánh dấu cached', async () => {
      await getProjectSummary('project-fallback-hit');
      mockAggregateSummaryByProjectId.mockClear();
      mockAggregateDisbursementsByProjectId.mockClear();
      mockFindCompletedDisbursementAmountsByProjectId.mockClear();

      const result = await getProjectSummary('project-fallback-hit');

      expect(result).toMatchObject({ cached: true, fallbackMode: true });
      expect(mockAggregateSummaryByProjectId).not.toHaveBeenCalled();
    });

    it('cache fallback bị đổi key HMAC thì bị loại bỏ và tính lại', async () => {
      vi.stubEnv('CACHE_HMAC_KEY', 'cache-key-a');
      await getProjectSummary('project-fallback-tamper');
      vi.stubEnv('CACHE_HMAC_KEY', 'cache-key-b');
      mockAggregateSummaryByProjectId.mockClear();

      const result = await getProjectSummary('project-fallback-tamper');

      expect(result.cached).toBe(false);
      expect(mockAggregateSummaryByProjectId).toHaveBeenCalledWith('project-fallback-tamper');
    });

    it('Redis throw khi đọc thì fallbackMode=true', async () => {
      const redis = createRedisMock({
        get: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
        set: vi.fn().mockRejectedValue(new Error('Redis unavailable'))
      });
      mockGetRedisClientIfReady.mockReturnValue(redis);

      const result = await getProjectSummary('project-redis-error');

      expect(result.fallbackMode).toBe(true);
    });

    it('Redis khỏe thì fallbackMode=false và set dùng TTL 300 giây', async () => {
      const redis = createRedisMock();
      mockGetRedisClientIfReady.mockReturnValue(redis);

      const result = await getProjectSummary('project-redis-healthy');

      expect(result.fallbackMode).toBe(false);
      expect(redis.set).toHaveBeenCalledWith(
        'transparency:summary:project-redis-healthy',
        expect.stringContaining('.'),
        { EX: 300 }
      );
    });

    it('invalidation theo projectId không xóa cache dự án khác', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        ...createEmptySummaryStats(),
        totalRaisedVnd: 123
      });
      await getProjectSummary('project-invalidate-a');
      await getProjectSummary('project-invalidate-b');

      await invalidateVerificationCache('project-invalidate-a');
      mockAggregateSummaryByProjectId.mockClear();
      mockAggregateDisbursementsByProjectId.mockClear();
      mockFindCompletedDisbursementAmountsByProjectId.mockClear();

      const retained = await getProjectSummary('project-invalidate-b');
      const removed = await getProjectSummary('project-invalidate-a');

      expect(retained.cached).toBe(true);
      expect(removed.cached).toBe(false);
      expect(mockAggregateSummaryByProjectId).toHaveBeenCalledWith('project-invalidate-a');
    });

    it('invalidation Redis theo projectId dùng exact UNLINK, không SCAN namespace', async () => {
      const scanIterator = vi.fn();
      const unlink = vi.fn().mockResolvedValue(1);
      const redis = {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        scanIterator,
        unlink
      };
      mockGetRedisClientIfReady.mockReturnValue(redis);

      await invalidateVerificationCache('project-redis-invalidate');

      expect(unlink).toHaveBeenCalledWith('transparency:summary:project-redis-invalidate');
      expect(scanIterator).not.toHaveBeenCalled();
    });

    it('invalidation toàn bộ Redis dùng SCAN rồi UNLINK các key summary', async () => {
      const scanIterator = vi.fn(() => (async function* (): AsyncGenerator<string[]> {
        yield ['transparency:summary:one', 'transparency:summary:two'];
      })());
      const unlink = vi.fn().mockResolvedValue(2);
      const redis = { get: vi.fn(), set: vi.fn(), del: vi.fn(), scanIterator, unlink };
      mockGetRedisClientIfReady.mockReturnValue(redis);

      await invalidateVerificationCache();

      expect(scanIterator).toHaveBeenCalledWith({
        MATCH: 'transparency:summary:*',
        COUNT: 200
      });
      expect(unlink).toHaveBeenCalledWith(
        'transparency:summary:one',
        'transparency:summary:two'
      );
    });
  });
});
