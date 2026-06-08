/**
 * Unit tests cho Task 6.1: QF Trust Weighting.
 * Cover computeQFScoreFromMetrics, applyDonationToMetrics, recomputeProjectMetrics
 * và các trustMultiplier guard conditions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies truoc khi import module can test
vi.mock('../../repositories/rankingIncrementalRepository', () => ({
  findAllProjectMetricsFromRepository: vi.fn(),
  findDonationsForProjectInWindow: vi.fn(),
  upsertProjectMetricsFromRepository: vi.fn()
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  findAuditsForProjectInWindow: vi.fn()
}));

vi.mock('../../services/rankingCacheService', () => ({
  invalidateRankingCache: vi.fn()
}));

vi.mock('../../services/rankingService', () => ({
  normalizeScoreNumber: vi.fn((n: number) => Math.round(n * 1000) / 1000)
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

// Import sau khi mock
import {
  computeQFScoreFromMetrics,
  applyDonationToMetrics,
  recomputeProjectMetrics
} from '../../services/rankingIncrementalService';
import {
  upsertProjectMetricsFromRepository
} from '../../repositories/rankingIncrementalRepository';
import {
  findDonationsForProjectInWindow
} from '../../repositories/rankingIncrementalRepository';
import {
  findAuditsForProjectInWindow
} from '../../repositories/anonymousDonationAuditRepository';

describe('computeQFScoreFromMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nên dung weightedSumSqrtDonations khi > 0 (guest donations)', () => {
    const metrics = {
      projectId: 'proj-1',
      totalRaisedAmount: 100,
      sumSqrtDonations: 20,
      weightedSumSqrtDonations: 15,
      donorAddresses: ['0xabc'],
      totalDonationCount: 5,
      guestDonationCount: 2,
      lastDonationAt: new Date(),
      lastFullRecomputeAt: new Date(),
      recomputeVersion: 1,
      updatedAt: new Date()
    };

    const result = computeQFScoreFromMetrics(metrics);

    // weightedSumSqrtDonations = 15 → QF_Score = 225
    expect(result.quadraticScoreRaw).toBe(225);
    // Matching = max(225 - 100, 0) = 125
    expect(result.matchingAmount).toBe(125);
    // Total = 100 + 125 = 225
    expect(result.totalFundingScore).toBe(225);
  });

  it('nên fallback ve sumSqrtDonations khi weightedSumSqrtDonations = 0 (legacy record)', () => {
    const metrics = {
      projectId: 'proj-1',
      totalRaisedAmount: 100,
      sumSqrtDonations: 20,
      weightedSumSqrtDonations: 0,
      donorAddresses: ['0xabc'],
      totalDonationCount: 5,
      guestDonationCount: 0,
      lastDonationAt: new Date(),
      lastFullRecomputeAt: new Date(),
      recomputeVersion: 1,
      updatedAt: new Date()
    };

    const result = computeQFScoreFromMetrics(metrics);

    // Fallback: sumSqrtDonations = 20 → QF_Score = 400
    expect(result.quadraticScoreRaw).toBe(400);
    // Matching = max(400 - 100, 0) = 300
    expect(result.matchingAmount).toBe(300);
    // Total = 100 + 300 = 400
    expect(result.totalFundingScore).toBe(400);
  });

  it('nên dung weightedSumSqrtDonations khi toan bo la registered donations (weighted > 0)', () => {
    // Truong hop: 2 registered donors → weightedSumSqrtDonations > 0 nhung khong co guest
    // → van dung weightedSumSqrtDonations (khong fallback)
    const metrics = {
      projectId: 'proj-1',
      totalRaisedAmount: 100,
      sumSqrtDonations: 20,
      weightedSumSqrtDonations: 20, // registered users: trustMultiplier = 1.0
      donorAddresses: ['0xabc', '0xdef'],
      totalDonationCount: 2,
      guestDonationCount: 0,
      lastDonationAt: new Date(),
      lastFullRecomputeAt: new Date(),
      recomputeVersion: 1,
      updatedAt: new Date()
    };

    const result = computeQFScoreFromMetrics(metrics);

    // weightedSumSqrtDonations > 0 → khong fallback → dung 20
    expect(result.quadraticScoreRaw).toBe(400);
    expect(result.matchingAmount).toBe(300);
    expect(result.totalFundingScore).toBe(400);
  });

  it('nên tra ve 0 cho project khong co donation', () => {
    const metrics = {
      projectId: 'proj-1',
      totalRaisedAmount: 0,
      sumSqrtDonations: 0,
      weightedSumSqrtDonations: 0,
      donorAddresses: [],
      totalDonationCount: 0,
      guestDonationCount: 0,
      lastDonationAt: null,
      lastFullRecomputeAt: null,
      recomputeVersion: 0,
      updatedAt: new Date()
    };

    const result = computeQFScoreFromMetrics(metrics);

    expect(result.quadraticScoreRaw).toBe(0);
    expect(result.matchingAmount).toBe(0);
    expect(result.totalFundingScore).toBe(0);
  });
});

describe('applyDonationToMetrics — trustMultiplier guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertProjectMetricsFromRepository).mockResolvedValue({} as never);
  });

  it('nên gui trustMultiplier = 1.0 (registered user) → guestDonationCount khong tang', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc', 1.0);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.totalRaisedAmount).toBe(100);
    expect(inc.sumSqrtDonations).toBe(10);
    expect(inc.weightedSumSqrtDonations).toBe(10); // 10 * 1.0
    expect(inc.guestDonationCount).toBeUndefined(); // khong tang guest count
    expect(inc.totalDonationCount).toBe(1);
  });

  it('nên gui trustMultiplier = 0.5 (MEDIUM guest) → guestDonationCount tang', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc', 0.5);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.totalRaisedAmount).toBe(100);
    expect(inc.sumSqrtDonations).toBe(10);
    expect(inc.weightedSumSqrtDonations).toBe(5); // 10 * 0.5
    expect(inc.guestDonationCount).toBe(1);
    expect(inc.totalDonationCount).toBe(1);
  });

  it('nen clamp trustMultiplier > 1.0 ve 1.0', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc', 2.5);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.weightedSumSqrtDonations).toBe(10); // 10 * 1.0 (da clamp)
    expect(inc.guestDonationCount).toBeUndefined(); // 1.0 khong phai guest
  });

  it('nen clamp trustMultiplier < 0 ve 1.0', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc', -0.5);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.weightedSumSqrtDonations).toBe(10); // 10 * 1.0 (da clamp)
  });

  it('nen clamp NaN ve 1.0', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc', NaN);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.weightedSumSqrtDonations).toBe(10); // 10 * 1.0 (da clamp)
  });

  it('nen skip khi projectId rong', async () => {
    await applyDonationToMetrics('', 100, '0xabc', 1.0);

    expect(vi.mocked(upsertProjectMetricsFromRepository).mock.calls.length).toBe(0);
  });

  it('nen skip khi donorAddress rong', async () => {
    await applyDonationToMetrics('proj-1', 100, '', 1.0);

    expect(vi.mocked(upsertProjectMetricsFromRepository).mock.calls.length).toBe(0);
  });

  it('nen skip khi amount am', async () => {
    await applyDonationToMetrics('proj-1', -50, '0xabc', 1.0);

    expect(vi.mocked(upsertProjectMetricsFromRepository).mock.calls.length).toBe(0);
  });

  it('nen skip khi amount la NaN', async () => {
    await applyDonationToMetrics('proj-1', NaN, '0xabc', 1.0);

    expect(vi.mocked(upsertProjectMetricsFromRepository).mock.calls.length).toBe(0);
  });

  it('nen skip khi amount la Infinity', async () => {
    await applyDonationToMetrics('proj-1', Infinity, '0xabc', 1.0);

    expect(vi.mocked(upsertProjectMetricsFromRepository).mock.calls.length).toBe(0);
  });

  it('nen default trustMultiplier = 1.0 khi khong truyen', async () => {
    await applyDonationToMetrics('proj-1', 100, '0xabc');

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.weightedSumSqrtDonations).toBe(10); // 10 * 1.0 (default)
    expect(inc.guestDonationCount).toBeUndefined();
  });

  it('nen tinh sqrt mot lan duy nhat cho ca hai sum fields', async () => {
    // Math.sqrt(25) = 5 — goi mot lan, dung cho ca hai
    await applyDonationToMetrics('proj-1', 25, '0xabc', 0.8);

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(inc.sumSqrtDonations).toBe(5);
    expect(inc.weightedSumSqrtDonations).toBe(4); // 5 * 0.8
  });
});

describe('recomputeProjectMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertProjectMetricsFromRepository).mockResolvedValue({} as never);
    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([]);
    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([]);
  });

  it('nen rebuild weightedSumSqrtDonations tu audit records cho guest donations', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000);

    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([
      {
        transactionHash: 'tx1',
        projectId: 'proj-1',
        donorAddress: '0xabc',
        amount: 100,
        timestamp: recent,
        isAnonymous: true,
        blockNumber: 1,
        donationStatus: 'INDEXED' as const,
        onChainConfirmedAt: recent,
        indexedAt: recent,
        correlationId: 'c1',
        createdAt: recent,
        updatedAt: recent
      }
    ]);

    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([
      {
        auditId: 'audit-1',
        sessionId: 'sess-1',
        walletAddress: '0xabc',
        projectId: 'proj-1',
        amount: 100,
        trustMultiplier: 0.5,
        riskScore: 30,
        userOpHash: 'uop-1',
        onChainTxHash: null,
        onChainBlockNumber: null,
        paymasterSponsoredGas: true,
        claimedByUserId: null,
        isAnonymous: true,
        ipAddress: '1.1.1.1',
        userAgent: 'test',
        createdAt: recent,
        indexedAt: null
      }
    ]);

    await recomputeProjectMetrics('proj-1');

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const set = updateOp.$set as Record<string, unknown>;
    const inc = updateOp.$inc as Record<string, number>;

    expect(set.totalRaisedAmount).toBe(100);
    expect(set.sumSqrtDonations).toBe(10);
    expect(set.weightedSumSqrtDonations).toBe(5); // 10 * 0.5
    expect(set.guestDonationCount).toBe(1);
    expect(inc.recomputeVersion).toBe(1); // tang dan bang $inc
  });

  it('nen cong weightedSum voi trustMultiplier = 1.0 cho registered donations', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000);

    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([
      {
        transactionHash: 'tx1',
        projectId: 'proj-1',
        donorAddress: '0xabc',
        amount: 100,
        timestamp: recent,
        isAnonymous: false, // registered user
        blockNumber: 1,
        donationStatus: 'INDEXED' as const,
        onChainConfirmedAt: recent,
        indexedAt: recent,
        correlationId: 'c1',
        createdAt: recent,
        updatedAt: recent
      }
    ]);

    // Khong co audit records (registered user khong co audit)
    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([]);

    await recomputeProjectMetrics('proj-1');

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const set = updateOp.$set as Record<string, unknown>;

    expect(set.weightedSumSqrtDonations).toBe(10); // 10 * 1.0
    expect(set.guestDonationCount).toBe(0);
  });

  it('nen su dung DEFAULT_GUEST_TRUST_MULTIPLIER (0.5) khi audit record khong tim thay', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000);

    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([
      {
        transactionHash: 'tx1',
        projectId: 'proj-1',
        donorAddress: '0xabc',
        amount: 100,
        timestamp: recent,
        isAnonymous: true, // guest
        blockNumber: 1,
        donationStatus: 'INDEXED' as const,
        onChainConfirmedAt: recent,
        indexedAt: recent,
        correlationId: 'c1',
        createdAt: recent,
        updatedAt: recent
      }
    ]);

    // Audit khong co record cho wallet nay
    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([]);

    await recomputeProjectMetrics('proj-1');

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const set = updateOp.$set as Record<string, unknown>;

    expect(set.weightedSumSqrtDonations).toBe(5); // 10 * 0.5 (DEFAULT)
  });

  it('nen clamp windowHours ve [1, 8760]', async () => {
    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([]);
    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([]);

    await recomputeProjectMetrics('proj-1', -100);

    // windowHours = -100 → clamp → 1
    const donationsCall = vi.mocked(findDonationsForProjectInWindow).mock.calls[0];
    const startedAt = donationsCall[1] as Date;
    const endedAt = donationsCall[2] as Date;
    const windowMs = endedAt.getTime() - startedAt.getTime();

    expect(windowMs).toBe(3600 * 1000); // 1 giờ
  });

  it('nen skip donation co amount am trong recompute', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000);

    vi.mocked(findDonationsForProjectInWindow).mockResolvedValue([
      {
        transactionHash: 'tx1',
        projectId: 'proj-1',
        donorAddress: '0xabc',
        amount: -50, // am
        timestamp: recent,
        isAnonymous: false,
        blockNumber: 1,
        donationStatus: 'INDEXED' as const,
        onChainConfirmedAt: recent,
        indexedAt: recent,
        correlationId: 'c1',
        createdAt: recent,
        updatedAt: recent
      }
    ]);

    vi.mocked(findAuditsForProjectInWindow).mockResolvedValue([]);

    await recomputeProjectMetrics('proj-1');

    const call = vi.mocked(upsertProjectMetricsFromRepository).mock.calls[0];
    const updateOp = call[1] as Record<string, unknown>;
    const set = updateOp.$set as Record<string, unknown>;

    // Amount am bi skip → totalRaisedAmount = 0
    expect(set.totalRaisedAmount).toBe(0);
    expect(set.sumSqrtDonations).toBe(0);
    expect(set.weightedSumSqrtDonations).toBe(0);
    expect(set.totalDonationCount).toBe(1); // van dem 1 donation
  });
});
