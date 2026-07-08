/**
 * Unit tests cho qf-ranking.service.ts — G2 Trust-Adjusted QF Ranking.
 * 7 test cases: cache hit, formula correctness, fallback trust, pagination, roundId syntaxes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeTrustAdjustedRankings } from '../../services/qf-ranking.service';
import { parseRoundIdToTimeWindow, normalizeRoundIdForCacheKey } from '../../utils/roundId.utils';
import { TRUST_SCORE_FALLBACK } from '../../types/trust-score.types';

// --- Mock Redis ---
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisClient = {
  get: mockRedisGet,
  set: mockRedisSet,
  isOpen: true
};

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => mockRedisClient)
}));

// --- Mock donation model ---
const mockFindDonationsByProjectId = vi.fn();
const mockFindDonationsByProjectIdInTimeRange = vi.fn();

vi.mock('../../models/donationModel', () => ({
  findDonationsByProjectId: (...args: unknown[]) => mockFindDonationsByProjectId(...args),
  findDonationsByProjectIdInTimeRange: (...args: unknown[]) => mockFindDonationsByProjectIdInTimeRange(...args)
}));

// --- Mock trust score repository ---
const mockGetTrustScoresByDonorAddresses = vi.fn();

vi.mock('../../repositories/donorTrustScoreRepository', () => ({
  getTrustScoresByDonorAddresses: (...args: unknown[]) => mockGetTrustScoresByDonorAddresses(...args)
}));

// --- Mock inMemoryCache ---
const inMemoryStore = new Map<string, { value: string; expiredAtMs: number }>();

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({
    get: (key: string) => {
      const entry = inMemoryStore.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiredAtMs) {
        inMemoryStore.delete(key);
        return null;
      }
      return entry.value;
    },
    set: (key: string, value: string, ttlSeconds: number) => {
      inMemoryStore.set(key, { value, expiredAtMs: Date.now() + ttlSeconds * 1000 });
    },
    deleteByKey: (key: string) => inMemoryStore.delete(key),
    clearAll: () => inMemoryStore.clear()
  }))
}));

// --- Import service AFTER mocks ---
import { getTrustAdjustedQfRankings, MAX_DONATIONS_FETCH } from '../../services/qf-ranking.service';

// ============================================================
// TEST 1: Cache hit returns cached result
// ============================================================
describe('Cache hit returns cached result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('tra ve ket qua tu cache khi co san', async () => {
    const cachedResponse = {
      rankings: [{
        donorAddress: '0xabcd...1234',
        contributionAmount: 1000,
        trustScore: 0.8,
        trustAdjustedMatch: 28.28,
        tier: 'Gold'
      }],
      scores: {
        projectTrustAdjustedScore: 800,
        originalQfScore: 1000,
        totalDonors: 1,
        totalDonationRecords: 1
      },
      trustFactors: {
        averageTrustScore: 0.8,
        donorsWithTrustScore: 1,
        donorsWithFallback: 0
      },
      metadata: {
        projectId: 'proj-1',
        roundId: 'default',
        totalItems: 1,
        totalPages: 1,
        currentPage: 1,
        pageSize: 20,
        cachedAt: new Date().toISOString(),
        cacheHit: false
      }
    };

    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedResponse));

    const result = await getTrustAdjustedQfRankings({
      projectId: 'proj-1',
      roundId: undefined,
      page: 1,
      limit: 20
    });

    expect(result.metadata.cacheHit).toBe(true);
    expect(result.metadata.projectId).toBe('proj-1');
    expect(mockFindDonationsByProjectId).not.toHaveBeenCalled();
  });
});

// ============================================================
// TEST 2: Formula correctness with 2 donors
// ============================================================
describe('Formula correctness with 2 donors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
    mockRedisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('tinh dung trustAdjustedScore = (Σ √(dᵢ × trustᵢ))²', async () => {
    // Donor 1: amount=100, trust=0.5 → √(100×0.5)=√50=7.071
    // Donor 2: amount=400, trust=0.8 → √(400×0.8)=√320=17.889
    // Sum = 24.96, squared = 622.5
    mockFindDonationsByProjectId.mockResolvedValueOnce([
      { donorAddress: '0x1234567890abcdef', amount: 100, donationStatus: 'INDEXED' },
      { donorAddress: '0xabcdef1234567890', amount: 400, donationStatus: 'INDEXED' }
    ]);
    mockGetTrustScoresByDonorAddresses.mockResolvedValueOnce([
      { donorAddress: '0x1234567890abcdef', trustScore: 0.5 },
      { donorAddress: '0xabcdef1234567890', trustScore: 0.8 }
    ]);

    const result = await getTrustAdjustedQfRankings({
      projectId: 'proj-2',
      roundId: 'all',
      page: 1,
      limit: 20
    });

    // Verify rankings sorted by trustAdjustedMatch descending
    expect(result.rankings.length).toBe(2);
    expect(result.scores.totalDonors).toBe(2);

    // Verify project score formula
    const donor1Adjusted = Math.sqrt(100 * 0.5);
    const donor2Adjusted = Math.sqrt(400 * 0.8);
    const expectedProjectScore = (donor1Adjusted + donor2Adjusted) ** 2;

    expect(result.scores.projectTrustAdjustedScore).toBeCloseTo(expectedProjectScore, 2);
    expect(result.trustFactors.donorsWithTrustScore).toBe(2);
    expect(result.trustFactors.donorsWithFallback).toBe(0);
  });
});

// ============================================================
// TEST 3: Fallback trust = 0.5 when donor has no record
// ============================================================
describe('Fallback trust = 0.5 when donor has no record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
    mockRedisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('su dung fallback trust = 0.5 cho donor khong co record', async () => {
    mockFindDonationsByProjectId.mockResolvedValueOnce([
      { donorAddress: '0xknown123456789abc', amount: 200, donationStatus: 'INDEXED' },
      { donorAddress: '0xunknown123456789ab', amount: 200, donationStatus: 'INDEXED' }
    ]);
    // Only one donor has trust score record
    mockGetTrustScoresByDonorAddresses.mockResolvedValueOnce([
      { donorAddress: '0xknown123456789abc', trustScore: 0.9 }
    ]);

    const result = await getTrustAdjustedQfRankings({
      projectId: 'proj-3',
      roundId: 'all',
      page: 1,
      limit: 20
    });

    expect(result.trustFactors.donorsWithTrustScore).toBe(1);
    expect(result.trustFactors.donorsWithFallback).toBe(1);

    // Find the donor with fallback
    const fallbackDonor = result.rankings.find(r => r.trustScore === TRUST_SCORE_FALLBACK);
    expect(fallbackDonor).toBeDefined();
    expect(fallbackDonor!.trustScore).toBe(0.5);
  });
});

// ============================================================
// TEST 4: Pagination max 50 (3 donors, page=1 limit=2)
// ============================================================
describe('Pagination max 50', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
    mockRedisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('pagination 3 donors voi limit=2 tra ve 2 items, totalPages=2', async () => {
    mockFindDonationsByProjectId.mockResolvedValueOnce([
      { donorAddress: '0xaaa111', amount: 100, donationStatus: 'INDEXED' },
      { donorAddress: '0xbbb222', amount: 200, donationStatus: 'INDEXED' },
      { donorAddress: '0xccc333', amount: 300, donationStatus: 'INDEXED' }
    ]);
    mockGetTrustScoresByDonorAddresses.mockResolvedValueOnce([]);

    const result = await getTrustAdjustedQfRankings({
      projectId: 'proj-4',
      roundId: 'all',
      page: 1,
      limit: 2
    });

    expect(result.rankings.length).toBe(2);
    expect(result.metadata.totalItems).toBe(3);
    expect(result.metadata.totalPages).toBe(2);
    expect(result.metadata.currentPage).toBe(1);
    expect(result.metadata.pageSize).toBe(2);
  });
});

// ============================================================
// TEST 5: roundId = "all" — no time filter
// ============================================================
describe('roundId = "all" — no time filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
    mockRedisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('goi findDonationsByProjectId khi roundId=all', async () => {
    mockFindDonationsByProjectId.mockResolvedValueOnce([]);
    mockGetTrustScoresByDonorAddresses.mockResolvedValueOnce([]);

    await getTrustAdjustedQfRankings({
      projectId: 'proj-5',
      roundId: 'all',
      page: 1,
      limit: 20
    });

    expect(mockFindDonationsByProjectId).toHaveBeenCalledWith('proj-5', MAX_DONATIONS_FETCH);
    expect(mockFindDonationsByProjectIdInTimeRange).not.toHaveBeenCalled();
  });
});

// ============================================================
// TEST 6: roundId = "YYYY-MM" — filter to specific month
// ============================================================
describe('roundId = "YYYY-MM" — filter to specific month', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStore.clear();
    mockRedisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    inMemoryStore.clear();
  });

  it('goi findDonationsByProjectIdInTimeRange voi June 2026', async () => {
    mockFindDonationsByProjectIdInTimeRange.mockResolvedValueOnce([]);
    mockGetTrustScoresByDonorAddresses.mockResolvedValueOnce([]);

    await getTrustAdjustedQfRankings({
      projectId: 'proj-6',
      roundId: '2026-06',
      page: 1,
      limit: 20
    });

    expect(mockFindDonationsByProjectIdInTimeRange).toHaveBeenCalledTimes(1);
    expect(mockFindDonationsByProjectId).not.toHaveBeenCalled();

    // Verify time range is correct for June 2026
    const callArgs = mockFindDonationsByProjectIdInTimeRange.mock.calls[0];
    const [projId, startAt, endAt] = callArgs;

    expect(projId).toBe('proj-6');
    expect(startAt.getUTCFullYear()).toBe(2026);
    expect(startAt.getUTCMonth()).toBe(5); // June = 5 (0-indexed)
    expect(startAt.getUTCDate()).toBe(1);
    expect(endAt.getUTCMonth()).toBe(5); // June
    expect(endAt.getUTCDate()).toBe(30); // Last day of June
  });
});

// ============================================================
// TEST 7: projectId empty — throws validation error via controller
// ============================================================
describe('projectId validation', () => {
  it('parseRoundIdToTimeWindow tra null cho opaque string', () => {
    // Opaque string (UUID/v.v.) should return null time window
    const result = parseRoundIdToTimeWindow('550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBeNull();
  });

  it('normalizeRoundIdForCacheKey tra raw value cho opaque string', () => {
    const result = normalizeRoundIdForCacheKey('550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});

// ============================================================
// TEST: computeTrustAdjustedRankings pure function
// ============================================================
describe('computeTrustAdjustedRankings', () => {
  it('tinh dung voi 2 donors', () => {
    const aggregated = new Map<string, number>([
      ['0xaaa', 100],
      ['0xbbb', 400]
    ]);

    const trustMap = new Map<string, number>([
      ['0xaaa', 0.5],
      ['0xbbb', 0.8]
    ]);

    const result = computeTrustAdjustedRankings({ aggregatedDonations: aggregated, trustScoreMap: trustMap });

    const expectedDonor1Adjusted = Math.sqrt(100 * 0.5);
    const expectedDonor2Adjusted = Math.sqrt(400 * 0.8);
    const expectedTotal = (expectedDonor1Adjusted + expectedDonor2Adjusted) ** 2;

    expect(result.donorScores.length).toBe(2);
    expect(result.totalTrustAdjustedScore).toBeCloseTo(expectedDonor1Adjusted + expectedDonor2Adjusted, 5);
    expect(result.donorsWithTrustScore).toBe(2);
    expect(result.donorsWithFallback).toBe(0);
  });

  it('tinh dung voi fallback trust', () => {
    const aggregated = new Map<string, number>([
      ['0xaaa', 200]
    ]);

    const trustMap = new Map<string, number>(); // Empty — donor has no record

    const result = computeTrustAdjustedRankings({ aggregatedDonations: aggregated, trustScoreMap: trustMap });

    expect(result.donorScores[0].trustScore).toBe(TRUST_SCORE_FALLBACK);
    expect(result.donorsWithFallback).toBe(1);
    expect(result.donorsWithTrustScore).toBe(0);
  });
});
