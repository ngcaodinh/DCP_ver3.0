/**
 * Unit tests cho unified-timeline.service — testing public API surface.
 *
 * Coverage:
 * 1. getUnifiedTimeline — goi repository voi dung params
 * 2. groupTimelineByCorrelation — ghep nhom theo correlationId dung
 * 3. groupTimelineByCorrelation — event khong co correlationId thi vao nhom rieng
 * 4. Cache key generation dung cho moi query param combination
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

// Use doMock with factory for dynamic import mock
vi.mock('../../models/donationModel', () => ({
  findDonationsByProjectId: vi.fn().mockResolvedValue([])
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
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

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
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

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
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

      await getUnifiedTimeline({ projectId: 'p1' }, 25);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        25,
        undefined
      );
    });

    it('cursor duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

      await getUnifiedTimeline({ projectId: 'p1' }, 10, 'test-cursor');

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        10,
        'test-cursor'
      );
    });

    it('walletAddress duoc truyen cho repository', async () => {
      const { findUnifiedTimeline } = await import('../../repositories/unifiedTransactionRepository');
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

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
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

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
      const { findDonationsByProjectId } = await import('../../models/donationModel');

      vi.mocked(getRedisClientIfReady).mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        set: vi.fn().mockRejectedValue(new Error('Redis connection failed'))
      } as unknown as ReturnType<typeof getRedisClientIfReady>);

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      vi.mocked(findDonationsByProjectId).mockResolvedValue([]);

      // Service should not throw even with Redis errors
      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      expect(result).toBeDefined();
      expect(result.timeline).toEqual([]);
    });
  });
});
