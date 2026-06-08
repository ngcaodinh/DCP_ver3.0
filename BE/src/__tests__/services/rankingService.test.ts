import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getCurrentRankingSnapshotPaginated, normalizeRankingQueryInput, recalculateRankingSnapshot } from '../../services/rankingService';
import * as rankingRepository from '../../repositories/rankingRepository';

vi.mock('../../repositories/rankingRepository', () => ({
  findDonationsWithMappedUserInTimeRange: vi.fn(),
  findAllProjectsByIds: vi.fn(),
  saveRankingSnapshot: vi.fn(),
  findCurrentRankingSnapshot: vi.fn()
}));

// Mock organizationKycModel để tránh real DB connection trong test.
// findLatestSubmissionByOrganizationId được gọi bên trong recalculateRankingSnapshot.
vi.mock('../../models/organizationKycModel', () => ({
  findLatestSubmissionByOrganizationId: vi.fn().mockResolvedValue(null)
}));

/** Hàm lấy repository mock typed an toàn. Mục đích: giảm lặp ép kiểu trong từng test case. */
function getRepositoryMock() {
  return rankingRepository as unknown as {
    findDonationsWithMappedUserInTimeRange: ReturnType<typeof vi.fn>;
    findAllProjectsByIds: ReturnType<typeof vi.fn>;
    saveRankingSnapshot: ReturnType<typeof vi.fn>;
    findCurrentRankingSnapshot: ReturnType<typeof vi.fn>;
  };
}

describe('rankingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chuẩn hóa query ranking đúng default và giới hạn', () => {
    const normalizedQuery = normalizeRankingQueryInput({ page: -1, limit: 999, sortBy: 'unknown' as never, sortDirection: 'unknown' as never });
    expect(normalizedQuery).toEqual({ page: 1, limit: 100, sortBy: 'rankPosition', sortDirection: 'desc' });
  });

  it('trả snapshot rỗng khi chưa có dữ liệu ranking', async () => {
    const repositoryMock = getRepositoryMock();
    repositoryMock.findCurrentRankingSnapshot.mockResolvedValue(null);

    const rankingResult = await getCurrentRankingSnapshotPaginated({ page: 2, limit: 5, sortBy: 'rankPosition', sortDirection: 'asc' });
    expect(rankingResult.items).toEqual([]);
    expect(rankingResult.metadata.currentPage).toBe(2);
    expect(rankingResult.metadata.totalItems).toBe(0);
  });

  it('tính ranking QF đúng với donation hợp lệ và loại bỏ invalid/sybil', async () => {
    const repositoryMock = getRepositoryMock();
    repositoryMock.findDonationsWithMappedUserInTimeRange.mockResolvedValue([
      { donationRecord: { amount: 100, projectId: 'P1', donorAddress: '0xA' }, mappedUser: { isSybil: false } },
      { donationRecord: { amount: 25, projectId: 'P1', donorAddress: '0xB' }, mappedUser: { isSybil: false } },
      { donationRecord: { amount: 16, projectId: 'P2', donorAddress: '0xC' }, mappedUser: { isSybil: false } },
      { donationRecord: { amount: 0, projectId: 'P2', donorAddress: '0xD' }, mappedUser: { isSybil: false } },
      { donationRecord: { amount: 9, projectId: 'P2', donorAddress: '0xE' }, mappedUser: { isSybil: true } }
    ]);
    repositoryMock.findAllProjectsByIds.mockResolvedValue([
      { projectId: 'P1', name: 'Project One', organizationId: 'Org1' },
      { projectId: 'P2', name: 'Project Two', organizationId: 'Org2' }
    ]);
    repositoryMock.saveRankingSnapshot.mockImplementation(async (payload: unknown) => payload);

    const snapshot = await recalculateRankingSnapshot(24);
    expect(snapshot.totalValidDonations).toBe(3);
    expect(snapshot.skippedInvalidDonationCount).toBe(1);
    expect(snapshot.skippedSybilDonationCount).toBe(1);
    expect(snapshot.rankingItems[0].projectId).toBe('P1');
    expect(snapshot.rankingItems[0].rankPosition).toBe(1);
  });
});
