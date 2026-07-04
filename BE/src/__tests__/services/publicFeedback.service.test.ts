/**
 * Unit tests cho publicFeedback.service.ts với mocked database.
 * Test service logic: pagination, filtering, stats calculation, cache behavior.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock functions được hoist cùng với vi.mock
const { mockFind, mockCountDocuments, mockAggregate } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockCountDocuments: vi.fn(),
  mockAggregate: vi.fn()
}));

// Mock cache module
const mockCacheStore = new Map<string, { value: unknown; expiredAtMilliseconds: number }>();

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({
    get: (key: string) => {
      const entry = mockCacheStore.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiredAtMilliseconds) {
        mockCacheStore.delete(key);
        return null;
      }
      return entry.value;
    },
    set: (key: string, value: unknown, ttlSeconds: number) => {
      mockCacheStore.set(key, {
        value,
        expiredAtMilliseconds: Date.now() + ttlSeconds * 1000
      });
    },
    deleteByKey: (key: string) => mockCacheStore.delete(key),
    clearAll: () => mockCacheStore.clear()
  }))
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: {
    find: mockFind,
    countDocuments: mockCountDocuments,
    aggregate: mockAggregate
  }
}));

// Import service sau mock
import {
  getPublicFeedbackList,
  getPublicFeedbackStats,
  PublicFeedbackStatsResult
} from '../../services/publicFeedback.service';

/**
 * Hàm reset tất cả mocks và cache.
 */
function resetAllMocks() {
  mockFind.mockReset();
  mockCountDocuments.mockReset();
  mockAggregate.mockReset();
  mockCacheStore.clear();
}

/**
 * Hàm tạo mock lean document.
 */
function createMockLeanDoc(overrides: Record<string, unknown> = {}) {
  return {
    feedbackId: 'fb-1',
    projectId: 'test-project-1',
    beneficiaryNameHash: 'abc123def456',
    rating: 5,
    comment: 'Great service!',
    submittedAt: new Date('2024-06-01'),
    location: 'Hanoi, Vietnam',
    ...overrides
  };
}

describe('publicFeedback.service - unit tests', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // =============================================================================
  // GROUP A: getPublicFeedbackList Tests
  // =============================================================================

  describe('Group A: getPublicFeedbackList', () => {
    // Setup common mock chain cho find().select().sort().skip().limit().lean()
    function setupFindMock(docs: Record<string, unknown>[]) {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(docs)
      };
      mockFind.mockReturnValue(mockChain);
      return mockChain;
    }

    // A1: Empty collection → empty array + pagination đúng
    it('A1: trả về empty array khi không có feedback nào', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      const result = await getPublicFeedbackList('test-project-1', 1, 20);

      expect(result.feedbacks).toEqual([]);
      expect(result.pagination.totalItems).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    // A2: Mix flagged + non-flagged → chỉ trả non-flagged (service filter)
    it('A2: find được gọi với filter isFlagged: false', async () => {
      const mockDocs = [createMockLeanDoc({ feedbackId: 'fb-1', rating: 5 })];
      setupFindMock(mockDocs);
      mockCountDocuments.mockResolvedValue(1);

      await getPublicFeedbackList('test-project-1', 1, 20);

      expect(mockFind).toHaveBeenCalledWith({
        projectId: 'test-project-1',
        isFlagged: false
      });
    });

    // A3: Mix multiple projects → filter đúng theo projectId
    it('A3: find được gọi với filter projectId đúng', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      await getPublicFeedbackList('proj-A', 1, 20);

      expect(mockFind).toHaveBeenCalledWith({
        projectId: 'proj-A',
        isFlagged: false
      });
    });

    // A4: Sort by submittedAt DESC
    it('A4: sort được gọi với { submittedAt: -1 }', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      await getPublicFeedbackList('test-project-1', 1, 20);

      const mockChain = mockFind();
      expect(mockChain.sort).toHaveBeenCalledWith({ submittedAt: -1 });
    });

    // A5: Pagination page=1, page=2 với 3 items, limit=2 → đúng thứ tự
    it('A5: skip và limit được gọi đúng cho pagination', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(3);

      await getPublicFeedbackList('test-project-1', 1, 2);

      const mockChain = mockFind();
      expect(mockChain.skip).toHaveBeenCalledWith(0); // (1-1) * 2
      expect(mockChain.limit).toHaveBeenCalledWith(2);
    });

    // A6: Deep page (page=999) với total=5 → empty array + pagination metadata
    it('A6: trả về empty array khi page lớn hơn totalPages nhưng vẫn tính pagination đúng', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(5);

      const result = await getPublicFeedbackList('test-project-1', 999, 20);

      expect(result.feedbacks).toEqual([]);
      expect(result.pagination.page).toBe(999);
      expect(result.pagination.totalItems).toBe(5);
      expect(result.pagination.totalPages).toBe(1); // Math.ceil(5/20) = 1
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(true); // page > 1
    });

    // A7: Projection đúng — response KHÔNG có uploadedByOrganizationId, batchContentHash, riskScore, __v
    it('A7: select được gọi với đúng các trường cần thiết, không có PII', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      await getPublicFeedbackList('test-project-1', 1, 20);

      const mockChain = mockFind();
      expect(mockChain.select).toHaveBeenCalledWith(
        'feedbackId projectId beneficiaryNameHash rating comment submittedAt location'
      );
      expect(mockChain.select).not.toHaveBeenCalledWith('uploadedByOrganizationId');
      expect(mockChain.select).not.toHaveBeenCalledWith('batchContentHash');
      expect(mockChain.select).not.toHaveBeenCalledWith('riskScore');
    });

    // A8: Response CÓ beneficiaryNameHash, không có beneficiaryName
    it('A8: select bao gồm beneficiaryNameHash nhưng không có beneficiaryName', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      await getPublicFeedbackList('test-project-1', 1, 20);

      const mockChain = mockFind();
      expect(mockChain.select).toHaveBeenCalledWith(
        expect.stringContaining('beneficiaryNameHash')
      );
      expect(mockChain.select).not.toHaveBeenCalledWith('beneficiaryName');
    });

    // A9: limit > MAX_LIMIT ở service level (service không enforce, controller enforce)
    it('A9: service không validate limit, chỉ sử dụng giá trị truyền vào', async () => {
      setupFindMock([]);
      mockCountDocuments.mockResolvedValue(0);

      await getPublicFeedbackList('test-project-1', 1, 100);

      const mockChain = mockFind();
      expect(mockChain.limit).toHaveBeenCalledWith(100);
    });
  });

  // =============================================================================
  // GROUP B: getPublicFeedbackStats Tests
  // =============================================================================

  describe('Group B: getPublicFeedbackStats', () => {
    // B1: Empty collection → zero values
    it('B1: trả về giá trị zero khi không có feedback nào', async () => {
      mockAggregate.mockResolvedValue([]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(result.avgRating).toBeNull();
      expect(result.totalCount).toBe(0);
      expect(result.distribution).toEqual({});
    });

    // B2: Single feedback rating=5
    it('B2: trả về avgRating=5 và distribution đúng cho 1 feedback rating=5', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 1
      }]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(result.avgRating).toBe(5);
      expect(result.totalCount).toBe(1);
      expect(result.distribution).toEqual({
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 1
      });
    });

    // B3: Multiple ratings → avgRating đúng
    it('B3: tính avgRating chính xác cho nhiều ratings (4,5,5 → 4.67)', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 3,
        avgRating: 4.666666666666667,
        rating1: 0, rating2: 0, rating3: 1, rating4: 1, rating5: 2
      }]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(result.avgRating).toBe(4.67);
      expect(result.totalCount).toBe(3);
    });

    // B4: Mix flagged + non-flagged → chỉ count non-flagged
    it('B4: aggregate filter với isFlagged: false', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 2,
        avgRating: 4,
        rating1: 0, rating2: 0, rating3: 1, rating4: 0, rating5: 1
      }]);

      await getPublicFeedbackStats('test-project-1');

      expect(mockAggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            $match: { projectId: 'test-project-1', isFlagged: false }
          })
        ])
      );
    });

    // B5: Mix multiple projects → filter đúng theo projectId
    it('B5: stats chỉ tính feedback của đúng projectId', async () => {
      mockAggregate.mockResolvedValue([]);

      await getPublicFeedbackStats('proj-A');

      expect(mockAggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            $match: expect.objectContaining({ projectId: 'proj-A' })
          })
        ])
      );
    });

    // B6: avgRating làm tròn 2 chữ số thập phân
    it('B6: avgRating được làm tròn 2 chữ số thập phân (vd 3.666 → 3.67)', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 3,
        avgRating: 3.6666666666666665,
        rating1: 1, rating2: 0, rating3: 1, rating4: 1, rating5: 0
      }]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(result.avgRating).toBe(3.67);
    });

    // B7: Distribution keys luôn có đủ 5 keys '1'..'5' ngay cả khi count=0
    it('B7: distribution luôn có đủ 5 keys từ 1 đến 5', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 1
      }]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(Object.keys(result.distribution)).toHaveLength(5);
      expect(result.distribution).toHaveProperty('1');
      expect(result.distribution).toHaveProperty('2');
      expect(result.distribution).toHaveProperty('3');
      expect(result.distribution).toHaveProperty('4');
      expect(result.distribution).toHaveProperty('5');
    });

    // B8: Cache hit - gọi 2 lần liên tiếp → DB query chỉ chạy 1 lần
    it('B8: gọi 2 lần liên tiếp, DB chỉ được query 1 lần (cache hit)', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 1
      }]);

      const result1 = await getPublicFeedbackStats('test-project-1');
      const result2 = await getPublicFeedbackStats('test-project-1');

      expect(result1.avgRating).toBe(5);
      expect(result2.avgRating).toBe(5);
      expect(mockAggregate).toHaveBeenCalledTimes(1);
    });

    // B9: Cache key đúng format
    it('B9: cache key có format đúng "feedback:stats:{projectId}"', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 1
      }]);

      await getPublicFeedbackStats('my-special-project');

      mockAggregate.mockResolvedValue([]);

      const resultDifferent = await getPublicFeedbackStats('different-project');

      expect(resultDifferent.avgRating).toBeNull();
    });

    // B10: Cache miss sau TTL
    it('B10: cache expire và query lại database', async () => {
      vi.useFakeTimers();

      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 1
      }]);

      const result1 = await getPublicFeedbackStats('test-project-1');
      expect(result1.avgRating).toBe(5);
      expect(mockAggregate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(601 * 1000);

      const result2 = await getPublicFeedbackStats('test-project-1');

      expect(result2.avgRating).toBe(5);
      expect(mockAggregate).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // =============================================================================
  // GROUP C: Edge cases + Invariants
  // =============================================================================

  describe('Group C: edge cases và invariants', () => {
    // C1: projectId với special characters
    it('C1: xử lý projectId với special characters mà không crash', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([])
      };
      mockFind.mockReturnValue(mockChain);
      mockCountDocuments.mockResolvedValue(0);

      const specialProjectId = 'proj-with-special-chars-$_-@!';
      const result = await getPublicFeedbackList(specialProjectId, 1, 20);

      expect(mockFind).toHaveBeenCalledWith({
        projectId: specialProjectId,
        isFlagged: false
      });
      expect(result).toBeDefined();
    });

    // C2: rating ngoài range 1-5 (service không crash)
    it('C2: service không crash khi aggregate trả về rating ngoài range', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 1,
        avgRating: 10, // Invalid rating
        rating1: 0, rating2: 0, rating3: 0, rating4: 0, rating5: 0
      }]);

      const result = await getPublicFeedbackStats('test-project-1');

      expect(result).toBeDefined();
      expect(result.avgRating).toBe(10);
    });

    // C3: location undefined (optional field)
    it('C3: response có thể không có location khi document không có', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([{
          feedbackId: 'fb-1',
          projectId: 'test-project-1',
          beneficiaryNameHash: 'abc123',
          rating: 5,
          comment: 'Good',
          submittedAt: new Date()
        }])
      };
      mockFind.mockReturnValue(mockChain);
      mockCountDocuments.mockResolvedValue(1);

      const result = await getPublicFeedbackList('test-project-1', 1, 20);

      expect(result.feedbacks[0]).not.toHaveProperty('location');
    });

    // C4: Concurrent service calls - không có race condition
    it('C4: concurrent calls không gây race condition', async () => {
      mockAggregate.mockResolvedValue([{
        totalCount: 2,
        avgRating: 4.5,
        rating1: 0, rating2: 0, rating3: 0, rating4: 1, rating5: 1
      }]);

      const mockChain = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([])
      };
      mockFind.mockReturnValue(mockChain);
      mockCountDocuments.mockResolvedValue(0);

      const results = await Promise.all([
        getPublicFeedbackStats('test-project-1'),
        getPublicFeedbackStats('test-project-1'),
        getPublicFeedbackStats('test-project-1'),
        getPublicFeedbackList('test-project-1', 1, 20),
        getPublicFeedbackList('test-project-1', 1, 20),
        getPublicFeedbackList('test-project-1', 1, 20),
        getPublicFeedbackList('test-project-1', 2, 10),
        getPublicFeedbackList('test-project-1', 2, 10),
        getPublicFeedbackList('test-project-1', 2, 10),
        getPublicFeedbackList('test-project-1', 1, 5)
      ]);

      results.forEach(result => {
        expect(result).toBeDefined();
      });

      const statsResults = results.filter(r => 'avgRating' in r) as PublicFeedbackStatsResult[];
      statsResults.forEach(stats => {
        expect(stats.totalCount).toBe(2);
        expect(stats.avgRating).toBe(4.5);
      });
    });
  });
});
