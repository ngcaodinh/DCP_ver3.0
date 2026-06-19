/**
 * Unit tests cho verification.service — testing public API surface.
 *
 * Coverage:
 * 1. verifyTransaction — tra ve found: false khi khong tim thay
 * 2. verifyTransaction — tra ve dung format khi tim thay
 * 3. verifyTransaction — bao gom thong tin chain khi co chainTxHash
 * 4. verifyTransaction — tinh dung totalDisbursed tu disbursements
 * 5. verifyTransaction — tinh dung disbursedRatioBps
 * 6. verifyTransaction — tra ve null disbursedRatioBps khi raised = 0
 * 7. getProjectSummary — tra ve zero values khi khong co transaction
 * 8. getProjectSummary — tinh dung remaining
 * 9. getProjectSummary — remaining = 0 khi disbursed > raised
 * 10. getProjectSummary — bao gom disbursedAmounts
 * 11. Cache hit tra ve cached: true
 * 12. Redis errors graceful fallback
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock setup
const mockFindUnifiedTxByCorrelationId = vi.fn();
const mockAggregateSummaryByProjectId = vi.fn();
const mockFindDisbursementsByProjectId = vi.fn();
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
  findDisbursementsByProjectId: (...args: unknown[]) => mockFindDisbursementsByProjectId(...args)
}));

vi.mock('../../models/disbursementTransferModel', () => ({
  findTransferLogsByRequestId: vi.fn().mockResolvedValue([])
}));

// Import after mocks
import {
  verifyTransaction,
  getProjectSummary
} from '../../services/verification.service';

describe('verification.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClientIfReady.mockReturnValue(null);
  });

  describe('verifyTransaction', () => {
    it('tra ve found: false khi khong tim thay transaction', async () => {
      mockFindUnifiedTxByCorrelationId.mockResolvedValue(null);
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await verifyTransaction('nonexistent:999');

      expect(result).toBeDefined();
      expect(result?.found).toBe(false);
      expect(result?.correlationId).toBe('nonexistent:999');
    });

    it('tra ve dung format khi tim thay transaction PayOS', async () => {
      const mockTx = {
        utxId: 'utx-001',
        correlationId: 'deposit:12345678',
        projectId: 'project-payos-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amountVnd: 50000,
        eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
        source: 'PAYOS',
        chainStatus: 'PENDING',
        chainTxHash: null,
        chainBlockNumber: null,
        payosStatus: 'PAYMENT_CONFIRMED',
        payosOrderCode: '12345678',
        eventType: 'DEPOSIT'
      };

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(mockTx);
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await verifyTransaction('deposit:12345678');

      expect(result).toBeDefined();
      expect(result?.found).toBe(true);
      expect(result?.correlationId).toBe('deposit:12345678');
      expect(result?.source).toBe('PAYOS');
      expect(result?.payos).toBeDefined();
      expect(result?.payos?.orderCode).toBe('12345678');
      expect(result?.payos?.status).toBe('PAYMENT_CONFIRMED');
      expect(result?.payos?.amount).toBe(50000);
    });

    it('bao gom thong tin chain khi co chainTxHash', async () => {
      const mockTx = {
        utxId: 'utx-002',
        correlationId: 'donation:0xtxhash123',
        projectId: 'project-chain-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amountVnd: 100000,
        eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
        source: 'BLOCKCHAIN',
        chainStatus: 'CONFIRMED',
        chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        chainBlockNumber: 12345678,
        payosStatus: null,
        payosOrderCode: null,
        eventType: 'DONATION'
      };

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(mockTx);
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await verifyTransaction('donation:0xtxhash123');

      expect(result).toBeDefined();
      expect(result?.found).toBe(true);
      expect(result?.source).toBe('BLOCKCHAIN');
      expect(result?.chain).toBeDefined();
      expect(result?.chain?.txHash).toContain('...'); // Da mask
      expect(result?.chain?.blockNumber).toBe(12345678);
      expect(result?.chain?.status).toBe('CONFIRMED');
    });

    it('tinh dung totalDisbursed tu disbursements', async () => {
      const mockTx = {
        utxId: 'utx-003',
        correlationId: 'deposit:disbursement-test-001',
        projectId: 'project-disbursement-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amountVnd: 100000,
        eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
        source: 'PAYOS',
        chainStatus: 'PENDING',
        chainTxHash: null,
        chainBlockNumber: null,
        payosStatus: 'PAYMENT_CONFIRMED',
        payosOrderCode: 'disbursement-test-001',
        eventType: 'DEPOSIT'
      };

      const disbursements = [
        { requestId: 'req-1', projectId: 'project-disbursement-001', amount: 20000, status: 'COMPLETED' },
        { requestId: 'req-2', projectId: 'project-disbursement-001', amount: 30000, status: 'COMPLETED' },
        { requestId: 'req-3', projectId: 'project-disbursement-001', amount: 15000, status: 'PENDING' }
      ];

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(mockTx);
      mockFindDisbursementsByProjectId.mockResolvedValue(disbursements);

      const result = await verifyTransaction('deposit:disbursement-test-001');

      expect(result).toBeDefined();
      expect(result?.totalDisbursed).toBe(50000); // 20000 + 30000 (chi COMPLETED)
      expect(result?.disbursementCount).toBe(2); // 2 COMPLETED
    });

    it('tinh dung disbursedRatioBps', async () => {
      const mockTx = {
        utxId: 'utx-004',
        correlationId: 'deposit:bips-test-001',
        projectId: 'project-bips-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amountVnd: 100000,
        eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
        source: 'PAYOS',
        chainStatus: 'PENDING',
        chainTxHash: null,
        chainBlockNumber: null,
        payosStatus: 'PAYMENT_CONFIRMED',
        payosOrderCode: 'bips-test-001',
        eventType: 'DEPOSIT'
      };

      const disbursements = [
        { requestId: 'req-bips-1', projectId: 'project-bips-001', amount: 50000, status: 'COMPLETED' }
      ];

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(mockTx);
      mockFindDisbursementsByProjectId.mockResolvedValue(disbursements);

      const result = await verifyTransaction('deposit:bips-test-001');

      expect(result?.disbursedRatioBps).toBe(5000); // 50000/100000 * 10000 = 5000 bps
    });

    it('tra ve null disbursedRatioBps khi raised = 0', async () => {
      const mockTx = {
        utxId: 'utx-005',
        correlationId: 'deposit:zero-test-001',
        projectId: 'project-zero-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amountVnd: 0,
        eventTimestamp: new Date('2024-06-15T10:30:00.000Z'),
        source: 'PAYOS',
        chainStatus: 'PENDING',
        chainTxHash: null,
        chainBlockNumber: null,
        payosStatus: 'PAYMENT_CONFIRMED',
        payosOrderCode: 'zero-test-001',
        eventType: 'DEPOSIT'
      };

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(mockTx);
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await verifyTransaction('deposit:zero-test-001');

      expect(result?.disbursedRatioBps).toBeNull();
    });
  });

  describe('getProjectSummary', () => {
    it('tra ve zero values khi khong co transaction', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 0,
        totalTransactions: 0
      });
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await getProjectSummary('project-empty-xyz-001');

      expect(result).toBeDefined();
      expect(result.projectId).toBe('project-empty-xyz-001');
      expect(result.totalRaised).toBe(0);
      expect(result.totalDisbursed).toBe(0);
      expect(result.remaining).toBe(0);
      expect(result.donorCount).toBe(0);
      expect(result.transactionCount).toBe(0);
    });

    it('tinh dung remaining = totalRaised - totalDisbursed', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 100000,
        totalTransactions: 5
      });
      
      const disbursements = [
        { requestId: 'req-remain-1', projectId: 'project-remaining-xyz-002', amount: 30000, status: 'COMPLETED' },
        { requestId: 'req-remain-2', projectId: 'project-remaining-xyz-002', amount: 20000, status: 'COMPLETED' }
      ];
      mockFindDisbursementsByProjectId.mockResolvedValue(disbursements);

      const result = await getProjectSummary('project-remaining-xyz-002');

      expect(result.totalRaised).toBe(100000);
      expect(result.totalDisbursed).toBe(50000);
      expect(result.remaining).toBe(50000);
    });

    it('tra ve remaining = 0 khi disbursed > raised', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 100000,
        totalTransactions: 3
      });
      
      const disbursements = [
        { requestId: 'req-over-1', projectId: 'project-over-xyz-003', amount: 150000, status: 'COMPLETED' }
      ];
      mockFindDisbursementsByProjectId.mockResolvedValue(disbursements);

      const result = await getProjectSummary('project-over-xyz-003');

      expect(result.remaining).toBe(0);
    });

    it('bao gom disbursedAmounts trong response', async () => {
      mockAggregateSummaryByProjectId.mockResolvedValue({
        totalRaisedVnd: 100000,
        totalTransactions: 3
      });
      
      const disbursements = [
        { requestId: 'req-amt-1', amount: 25000, status: 'COMPLETED' },
        { requestId: 'req-amt-2', amount: 35000, status: 'COMPLETED' },
        { requestId: 'req-amt-3', amount: 25000, status: 'PENDING' }
      ];
      mockFindDisbursementsByProjectId.mockResolvedValue(disbursements);

      const result = await getProjectSummary('project-amounts-xyz-004');

      expect(result.disbursedAmounts).toEqual([25000, 35000]); // Chi COMPLETED
      expect(result.disbursementCount).toBe(2);
    });
  });

  describe('cache functionality', () => {
    it('tra ve cached: true khi Redis cache co du lieu (verify)', async () => {
      const cachedResult = {
        found: true,
        correlationId: 'deposit:cache-verify-001',
        source: 'PAYOS',
        payos: {
          orderCode: 'cache-verify-001',
          amount: 50000,
          status: 'PAYMENT_CONFIRMED',
          timestamp: '2024-06-15T10:30:00.000Z'
        },
        totalDisbursed: 0,
        disbursementCount: 0,
        disbursedRatioBps: null,
        cached: false,
        fallbackMode: false
      };

      mockGetRedisClientIfReady.mockReturnValue({
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedResult)),
        set: vi.fn().mockResolvedValue('OK')
      });

      const result = await verifyTransaction('deposit:cache-verify-001');

      expect(result?.cached).toBe(true);
    });

    it('tra ve cached: true khi Redis cache co du lieu (summary)', async () => {
      const cachedSummary = {
        projectId: 'project-cache-summary-xyz-005',
        totalRaised: 100000,
        totalDisbursed: 50000,
        remaining: 50000,
        donorCount: 10,
        transactionCount: 15,
        disbursementCount: 2,
        disbursedAmounts: [25000, 25000],
        cached: false,
        fallbackMode: false
      };

      mockGetRedisClientIfReady.mockReturnValue({
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedSummary)),
        set: vi.fn().mockResolvedValue('OK')
      });

      const result = await getProjectSummary('project-cache-summary-xyz-005');

      expect(result.cached).toBe(true);
    });

    it('Redis errors graceful fallback — khong crash service', async () => {
      mockGetRedisClientIfReady.mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        set: vi.fn().mockRejectedValue(new Error('Redis connection failed'))
      });

      mockFindUnifiedTxByCorrelationId.mockResolvedValue(null);
      mockFindDisbursementsByProjectId.mockResolvedValue([]);

      const result = await verifyTransaction('deposit:redis-error-001');

      expect(result).toBeDefined();
      expect(result?.found).toBe(false);
    });
  });
});
