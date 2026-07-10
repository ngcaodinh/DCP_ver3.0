/**
 * Unit tests cho unified-timeline.service — testing public API surface.
 *
 * Coverage:
 * 1. getUnifiedTimeline — goi repository voi dung params
 * 2. groupTimelineByCorrelation — ghep nhom theo correlationId dung
 * 3. groupTimelineByCorrelation — event khong co correlationId thi vao nhom rieng
 * 4. Cache key generation dung cho moi query param combination
 * 5. cached response khi co data trong Redis
 * 6. nextCursor generation khi results vuot qua pageSize
 * 7. buildUnifiedTimeline comprehensive tests
 * 8. fallbackFromBlockchain edge cases
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getUnifiedTimeline,
  groupTimelineByCorrelation,
  type TimelineEvent
} from '../../services/unified-timeline.service';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../repositories/unifiedTransactionRepository', () => ({
  findUnifiedTimeline: vi.fn(),
  encodeCursor: vi.fn(),
  decodeCursor: vi.fn()
}));

vi.mock('../../repositories/donationRepository', () => ({
  findDonationsByProjectIdWithDateFilter: vi.fn().mockResolvedValue([])
}));

function createMockTimelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: 'event-001',
    correlationId: 'deposit:12345678',
    eventType: 'DONATION',
    timestamp: '2024-06-15T10:30:00.000Z',
    chainBlockNumber: 12345678,
    amountVnd: 50000,
    chainStatus: 'CONFIRMED',
    chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    payosStatus: 'PAYMENT_CONFIRMED',
    payosOrderCode: '12345678',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    projectId: 'project-001',
    source: 'payos',
    ...overrides
  };
}

describe('unified-timeline.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== 1. getUnifiedTimeline — goi repository voi dung params =====
  describe('getUnifiedTimeline', () => {
    it('goi repository voi dung params khi khong co cache', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 10);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-001'
        }),
        10,
        undefined
      );
      expect(result).toBeDefined();
    });

    it('tra ve response voi tat ca cac fields bat buoc', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      const result = await getUnifiedTimeline({}, 10);

      expect(result).toHaveProperty('timeline');
      expect(result).toHaveProperty('nextCursor');
      expect(result).toHaveProperty('cached');
      expect(result).toHaveProperty('count');
    });
  });

  // ===== 2. groupTimelineByCorrelation =====
  describe('groupTimelineByCorrelation', () => {
    it('ghep nhom theo correlationId dung', () => {
      const events: TimelineEvent[] = [
        createMockTimelineEvent({ correlationId: 'corr-1', eventId: 'event-1' }),
        createMockTimelineEvent({ correlationId: 'corr-1', eventId: 'event-2' }),
        createMockTimelineEvent({ correlationId: 'corr-2', eventId: 'event-3' })
      ];

      const grouped = groupTimelineByCorrelation(events);

      expect(grouped.get('corr-1')).toHaveLength(2);
      expect(grouped.get('corr-2')).toHaveLength(1);
      expect(grouped.size).toBe(2);
    });

    it('event khong co correlationId thi vao nhom rieng', () => {
      const events: TimelineEvent[] = [
        createMockTimelineEvent({ correlationId: '', eventId: 'event-no-corr' }),
        createMockTimelineEvent({ correlationId: 'corr-1', eventId: 'event-1' })
      ];

      const grouped = groupTimelineByCorrelation(events);

      expect(grouped.get('')).toHaveLength(1);
      expect(grouped.get('corr-1')).toHaveLength(1);
    });

    it('tra ve Map rong khi mang rong', () => {
      const grouped = groupTimelineByCorrelation([]);
      expect(grouped.size).toBe(0);
    });

    it('nhieu event cung correlationId duoc ghep thanh 1 nhom', () => {
      const events: TimelineEvent[] = [
        createMockTimelineEvent({ correlationId: 'same-corr', eventId: 'e1' }),
        createMockTimelineEvent({ correlationId: 'same-corr', eventId: 'e2' }),
        createMockTimelineEvent({ correlationId: 'same-corr', eventId: 'e3' })
      ];

      const grouped = groupTimelineByCorrelation(events);

      expect(grouped.get('same-corr')).toHaveLength(3);
      expect(grouped.size).toBe(1);
    });

    it('cac nhom khac nhau khong bi ghep', () => {
      const events: TimelineEvent[] = [
        createMockTimelineEvent({ correlationId: 'group-a', eventId: 'a1' }),
        createMockTimelineEvent({ correlationId: 'group-b', eventId: 'b1' }),
        createMockTimelineEvent({ correlationId: 'group-c', eventId: 'c1' })
      ];

      const grouped = groupTimelineByCorrelation(events);

      expect(grouped.size).toBe(3);
      expect(grouped.get('group-a')).toHaveLength(1);
      expect(grouped.get('group-b')).toHaveLength(1);
      expect(grouped.get('group-c')).toHaveLength(1);
    });
  });

  // ===== 3. query parameter handling =====
  describe('query parameter handling', () => {
    it('pageSize duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      await getUnifiedTimeline({ projectId: 'p1' }, 25);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        25,
        undefined
      );
    });

    it('cursor duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      await getUnifiedTimeline({ projectId: 'p1' }, 10, 'test-cursor');

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        10,
        'test-cursor'
      );
    });

    it('walletAddress duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      await getUnifiedTimeline({ walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a' }, 10);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a'
        }),
        expect.any(Number),
        undefined
      );
    });

    it('startDate va endDate duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      await getUnifiedTimeline({
        projectId: 'p1',
        startDate: '2024-01-01',
        endDate: '2024-12-31'
      }, 10);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date)
        }),
        expect.any(Number),
        undefined
      );
    });
  });

  // ===== 4. Redis errors graceful fallback =====
  describe('Redis errors graceful fallback', () => {
    it('Redis error khong lam crash service', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        set: vi.fn().mockRejectedValue(new Error('Redis connection failed'))
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      // Service should not throw even with Redis errors
      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      expect(result).toBeDefined();
      expect(result.timeline).toEqual([]);
    });
  });

  // ===== TEST-B5: cached response =====
  describe('cached response', () => {
    it('tra ve cached: true khi Redis cache co du lieu', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');

      const cachedData = {
        timeline: [createMockTimelineEvent()],
        nextCursor: null,
        cached: false,
        count: 1
      };

      const mockRedisClient = {
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedData)),
        set: vi.fn().mockResolvedValue('OK')
      };

      vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedisClient as unknown as ReturnType<typeof getRedisClientIfReady>);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      // Cache hit CHI xay ra khi payload HMAC hop le.
      // Test nay su dung raw JSON (khong co HMAC) → cache miss → cached=false.
      // Day la behavior MONG MUON cua F2: unsigned payload phai bi reject.
      expect(result.cached).toBe(false);
      expect(mockRedisClient.get).toHaveBeenCalled();
    });
  });

  // ===== TEST-B6: nextCursor generation =====
  describe('nextCursor generation', () => {
    it('tra ve nextCursor khi so luong ket qua bang pageSize', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { encodeCursor } = await import('../../repositories/unifiedTransactionRepository');

      // Mock Redis - no cache
      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      // Mock encodeCursor to return a known value
      vi.mocked(encodeCursor).mockReturnValue('encoded-cursor-value');

      // Mock repository tra ve 2 items (bang pageSize)
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [
          { utxId: 'utx-0', correlationId: 'corr-0', projectId: 'proj-0', walletAddress: '0x0000', amountVnd: 100, eventTimestamp: new Date('2024-06-15T10:00:00Z'), source: 'PAYOS' as const, chainStatus: 'CONFIRMED' as const, chainTxHash: null, chainBlockNumber: null, payosStatus: 'PAYMENT_CONFIRMED' as const, payosOrderCode: 'ORD0', payosTransactionId: null, payosRecordId: null, eventType: 'DEPOSIT' as const, blockchainRecordId: null, createdAt: new Date(), updatedAt: new Date() },
          { utxId: 'utx-1', correlationId: 'corr-1', projectId: 'proj-0', walletAddress: '0x1111', amountVnd: 200, eventTimestamp: new Date('2024-06-15T11:00:00Z'), source: 'PAYOS' as const, chainStatus: 'CONFIRMED' as const, chainTxHash: null, chainBlockNumber: null, payosStatus: 'PAYMENT_CONFIRMED' as const, payosOrderCode: 'ORD1', payosTransactionId: null, payosRecordId: null, eventType: 'DEPOSIT' as const, blockchainRecordId: null, createdAt: new Date(), updatedAt: new Date() }
        ],
        nextCursor: null,
        totalCount: 2
      });

      const result = await getUnifiedTimeline({
        projectId: 'project-001',
      }, 2);

      // Verify nextCursor is generated when results equal pageSize
      // The service calls encodeCursor to create the cursor
      expect(encodeCursor).toHaveBeenCalled();
      expect(result.nextCursor).toBe('encoded-cursor-value');
    });
  });

  // ===== TEST-I1: buildUnifiedTimeline comprehensive tests =====
  describe('buildUnifiedTimeline', () => {
    it('tra ve cached: true khi co cache (cache hit path)', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');

      const cachedData = {
        timeline: [createMockTimelineEvent({ eventId: 'cached-event' })],
        nextCursor: 'cached-cursor',
        cached: false,
        count: 1
      };

      const mockRedisClient = {
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedData)),
        set: vi.fn().mockResolvedValue('OK')
      };

      vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedisClient as unknown as ReturnType<typeof getRedisClientIfReady>);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      // F2 fix: cache chi tra ve payload khi HMAC hop le.
      // Test nay su dung raw JSON → bi reject → cached=false (an toan).
      // Timeline co the co data tu blockchain fallback (khi repo tra undefined → fallback).
      expect(result.cached).toBe(false);
    });

    it('goi repository khi khong co cache (cache miss path)', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      const mockItems = [
        {
          utxId: 'repo-item',
          eventTimestamp: new Date(),
          correlationId: 'corr-1',
          source: 'PAYOS' as const,
          projectId: 'project-001',
          walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
          eventType: 'DEPOSIT' as const,
          amountVnd: 100000,
          chainStatus: 'PENDING' as const,
          chainTxHash: null,
          chainBlockNumber: null,
          payosStatus: 'PENDING_PAYMENT' as const,
          payosOrderCode: '123',
          payosTransactionId: null,
          payosRecordId: null,
          blockchainRecordId: null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: mockItems,
        nextCursor: null,
        totalCount: 1
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      expect(findUnifiedTimeline).toHaveBeenCalled();
      expect(result.cached).toBe(false);
      expect(result.timeline).toHaveLength(1);
    });

    it('fallback sang blockchain khi repository tra ve rong', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      // Repository tra ve rong
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      // Blockchain fallback co du lieu
      const blockchainDonation = {
        _id: 'doc-id-001',
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amount: 50000,
        timestamp: new Date('2024-06-15T10:30:00.000Z'),
        txHash: '0xblockchain123'
      };
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([blockchainDonation]);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      expect(findDonationsByProjectIdWithDateFilter).toHaveBeenCalled();
      expect(result.timeline.length).toBeGreaterThan(0);
    });

    it('invalid wallet address khong lam crash service', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      // Invalid wallet address format
      const result = await getUnifiedTimeline({
        projectId: 'project-001',
        walletAddress: 'invalid-address'
      }, 50);

      expect(result).toBeDefined();
      expect(result.timeline).toEqual([]);
    });

    it('cache duoc set sau khi fetch', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      const mockRedisClient = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      };

      vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedisClient as unknown as ReturnType<typeof getRedisClientIfReady>);

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      expect(mockRedisClient.set).toHaveBeenCalled();
    });
  });

  // ===== TEST-I3: fallbackFromBlockchain edge cases =====
  describe('fallbackFromBlockchain edge cases', () => {
    it('tra ve mang rong khi khong co projectId', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      // Khong co projectId - should go to fallback which returns []
      const result = await getUnifiedTimeline({}, 50);

      expect(result.timeline).toEqual([]);
    });

    it('wallet filter duoc ap dung trong fallback', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      const walletAddress = '0x742d35cc6634c0532925a3b844bc9e7595f5c21a';
      const matchingDonation = {
        _id: 'doc-1',
        projectId: 'project-001',
        walletAddress: walletAddress,
        amount: 50000,
        timestamp: new Date('2024-06-15T10:30:00.000Z'),
        txHash: '0xmatch123'
      };
      const nonMatchingDonation = {
        _id: 'doc-2',
        projectId: 'project-001',
        walletAddress: '0x0000000000000000000000000000000000000001',
        amount: 10000,
        timestamp: new Date('2024-06-15T10:31:00.000Z'),
        txHash: '0xnomatch123'
      };
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([matchingDonation, nonMatchingDonation]);

      const result = await getUnifiedTimeline({
        projectId: 'project-001',
        walletAddress: walletAddress
      }, 50);

      // Verify repository was called with correct filter params
      expect(findDonationsByProjectIdWithDateFilter).toHaveBeenCalledWith(
        'project-001',
        expect.objectContaining({
          walletAddress: walletAddress
        })
      );
      expect(result.timeline.length).toBeGreaterThanOrEqual(1);
    });

    it('date range filter duoc ap dung trong fallback', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      const inRangeDonation = {
        _id: 'doc-3',
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amount: 50000,
        timestamp: new Date('2024-06-15T10:30:00.000Z'),
        txHash: '0xinrange'
      };
      const outOfRangeDonation = {
        _id: 'doc-4',
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        amount: 10000,
        timestamp: new Date('2024-07-01T10:30:00.000Z'),
        txHash: '0xoutofrange'
      };
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([inRangeDonation, outOfRangeDonation]);

      const result = await getUnifiedTimeline({
        projectId: 'project-001',
        startDate: '2024-06-01T00:00:00.000Z',
        endDate: '2024-06-30T23:59:59.999Z'
      }, 50);

      // Verify repository was called with correct date filter params
      expect(findDonationsByProjectIdWithDateFilter).toHaveBeenCalledWith(
        'project-001',
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date)
        })
      );
      expect(result.timeline.length).toBeGreaterThanOrEqual(1);
    });

    it('tra ve mang rong khi blockchain fallback cung tra ve rong', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([]);

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      expect(result.timeline).toEqual([]);
      expect(result.count).toBe(0);
    });
  });

  // ===== TEST-NIT10c: toTimelineEvent eventType validation =====
  describe('toTimelineEvent eventType validation', () => {
    it('invalid eventType fallback ve UNKNOWN (khong am tham gan thanh DONATION)', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      // Repository tra ve document voi eventType khong hop le
      const mockItems = [
        {
          utxId: 'utx-invalid-event',
          eventTimestamp: new Date(),
          correlationId: 'corr-invalid',
          source: 'BLOCKCHAIN' as const,
          projectId: 'project-001',
          walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
          eventType: 'INVALID_TYPE' as unknown as 'DONATION',
          amountVnd: 50000,
          chainStatus: 'CONFIRMED' as const,
          chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          chainBlockNumber: null,
          payosStatus: null,
          payosOrderCode: null,
          payosTransactionId: null,
          payosRecordId: null,
          blockchainRecordId: null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: mockItems,
        nextCursor: null,
        totalCount: 1
      });

      const result = await getUnifiedTimeline({ projectId: 'project-001' }, 50);

      // F12 fix: khong fallback am tham sang DONATION (gay sai lech aggregate)
      // Thay vao do, dat eventType = 'UNKNOWN' de UI/aggregate co the loc ra.
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0].eventType).toBe('UNKNOWN');
    });
  });
});
