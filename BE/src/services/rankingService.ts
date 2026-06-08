import { findAllProjectsByIds, findCurrentRankingSnapshot, findDonationsWithMappedUserInTimeRange, saveRankingSnapshot } from '../repositories/rankingRepository';
import { RankingProjectItem, RankingSnapshotRecord } from '../models/rankingModel';
import { findLatestSubmissionByOrganizationId } from '../models/organizationKycModel';
import { invalidateRankingCache } from './rankingCacheService';

type RankingSortBy = 'rankPosition' | 'totalFundingScore' | 'totalRaisedAmount' | 'uniqueDonorCount';
type RankingSortDirection = 'asc' | 'desc';

type RankingQueryInput = { page: number; limit: number; sortBy: RankingSortBy; sortDirection: RankingSortDirection };

/** Hàm chuẩn hóa số làm tròn cho điểm QF. Mục đích: giữ số liệu ổn định khi sort và hiển thị. */
export function normalizeScoreNumber(scoreNumber: number): number {
  return Number(scoreNumber.toFixed(6));
}

/** Hàm chuẩn hóa số giờ cửa sổ tính ranking. Mục đích: chặn giá trị bất thường gây query quá rộng. */
function normalizeWindowHours(windowHours: number): number {
  if (!Number.isFinite(windowHours)) {
    return 720;
  }
  return Math.max(1, Math.min(720, Math.floor(windowHours)));
}

/** Hàm chuẩn hóa tham số query bảng xếp hạng. Mục đích: gom validation page/limit/sort về một điểm rõ ràng. */
export function normalizeRankingQueryInput(input: Partial<RankingQueryInput>): RankingQueryInput {
  const page = Number.isFinite(input.page) ? Math.max(1, Math.floor(Number(input.page))) : 1;
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.floor(Number(input.limit)))) : 10;
  const sortByList: RankingSortBy[] = ['rankPosition', 'totalFundingScore', 'totalRaisedAmount', 'uniqueDonorCount'];
  const sortBy = sortByList.includes(input.sortBy as RankingSortBy) ? (input.sortBy as RankingSortBy) : 'rankPosition';
  const sortDirection = input.sortDirection === 'asc' ? 'asc' : 'desc';
  return { page, limit, sortBy, sortDirection };
}

/** Hàm tính bảng xếp hạng QF theo dữ liệu donation. Mục đích: tạo snapshot ranking mới nhất cho FR4/UC4.1. */
export async function recalculateRankingSnapshot(requestedWindowHours: number): Promise<RankingSnapshotRecord> {
  const calculationWindowHours = normalizeWindowHours(requestedWindowHours);
  const calculationWindowEndedAt = new Date();
  const calculationWindowStartedAt = new Date(calculationWindowEndedAt.getTime() - calculationWindowHours * 60 * 60 * 1000);
  const donationWithUserList = await findDonationsWithMappedUserInTimeRange(calculationWindowStartedAt, calculationWindowEndedAt);

  const aggregationByProjectId = new Map<string, { donationAmountList: number[]; totalRaisedAmount: number; donorAddressSet: Set<string> }>();
  let skippedInvalidDonationCount = 0;
  let skippedSybilDonationCount = 0;

  for (const donationWithUserItem of donationWithUserList) {
    const donatedAmount = Number(donationWithUserItem.donationRecord.amount);
    if (!Number.isFinite(donatedAmount) || donatedAmount <= 0) {
      skippedInvalidDonationCount += 1;
      continue;
    }
    if (donationWithUserItem.mappedUser?.isSybil) {
      skippedSybilDonationCount += 1;
      continue;
    }

    const projectId = donationWithUserItem.donationRecord.projectId;
    const donorAddress = donationWithUserItem.donationRecord.donorAddress.toLowerCase();
    const currentAggregation = aggregationByProjectId.get(projectId) || {
      donationAmountList: [],
      totalRaisedAmount: 0,
      donorAddressSet: new Set<string>()
    };

    currentAggregation.donationAmountList.push(donatedAmount);
    currentAggregation.totalRaisedAmount += donatedAmount;
    currentAggregation.donorAddressSet.add(donorAddress);
    aggregationByProjectId.set(projectId, currentAggregation);
  }

  const projectList = await findAllProjectsByIds(Array.from(aggregationByProjectId.keys()));

  // Ghi chú logic phức tạp: lấy tên tổ chức thật từ collection OrganizationKycSubmission thay vì dùng UUID.
  // Sử dụng Set để deduplicate organizationId trước khi query, tránh N+1 queries không cần thiết.
  const uniqueOrganizationIdList = [...new Set(projectList.map(projectItem => projectItem.organizationId))];
  const organizationNameByIdMap = new Map<string, string>();
  await Promise.all(
    uniqueOrganizationIdList.map(async (orgId) => {
      const kycSubmission = await findLatestSubmissionByOrganizationId(orgId);
      // Ưu tiên organizationName từ KYC, fallback về orgId nếu chưa có hồ sơ
      organizationNameByIdMap.set(orgId, kycSubmission?.organizationName || orgId);
    })
  );

  const rankingItemList: RankingProjectItem[] = projectList
    .map(projectItem => {
      const projectAggregation = aggregationByProjectId.get(projectItem.projectId);
      if (!projectAggregation || !projectAggregation.donationAmountList.length) {
        return null;
      }

      // Ghi chú logic phức tạp: áp dụng đồng thời 2 biến thể QF để tránh mơ hồ tài liệu FR4.
      const sumSquareRootDonation = projectAggregation.donationAmountList.reduce((sumValue, donationAmount) => sumValue + Math.sqrt(donationAmount), 0);
      const quadraticScoreRaw = normalizeScoreNumber(sumSquareRootDonation * sumSquareRootDonation);
      const totalRaisedAmount = normalizeScoreNumber(projectAggregation.totalRaisedAmount);
      const matchingAmount = normalizeScoreNumber(Math.max(quadraticScoreRaw - totalRaisedAmount, 0));
      const totalFundingScore = normalizeScoreNumber(totalRaisedAmount + matchingAmount);

      return {
        projectId: projectItem.projectId,
        projectName: projectItem.name,
        organizationName: organizationNameByIdMap.get(projectItem.organizationId) || projectItem.organizationId,
        rankPosition: 0,
        totalRaisedAmount,
        uniqueDonorCount: projectAggregation.donorAddressSet.size,
        quadraticScoreRaw,
        matchingAmount,
        totalFundingScore
      };
    })
    .filter((item): item is RankingProjectItem => Boolean(item));

  rankingItemList.sort((leftItem, rightItem) => {
    if (rightItem.totalFundingScore !== leftItem.totalFundingScore) return rightItem.totalFundingScore - leftItem.totalFundingScore;
    if (rightItem.uniqueDonorCount !== leftItem.uniqueDonorCount) return rightItem.uniqueDonorCount - leftItem.uniqueDonorCount;
    if (rightItem.totalRaisedAmount !== leftItem.totalRaisedAmount) return rightItem.totalRaisedAmount - leftItem.totalRaisedAmount;
    return leftItem.projectId.localeCompare(rightItem.projectId);
  });

  rankingItemList.forEach((rankingItem, index) => { rankingItem.rankPosition = index + 1; });

  return saveRankingSnapshot({
    snapshotId: 'current-ranking',       // Luôn dùng ID cố định — rankingModel.ts sẽ UPSERT vào document này
    calculatedAt: calculationWindowEndedAt,
    calculationWindowHours,
    calculationWindowStartedAt,
    calculationWindowEndedAt,
    totalValidDonations: donationWithUserList.length - skippedInvalidDonationCount - skippedSybilDonationCount,
    skippedInvalidDonationCount,
    skippedSybilDonationCount,
    rankingItems: rankingItemList,
    createdAt: new Date()
  });
}

/**
 * Hàm cập nhật bảng xếp hạng QF ngay lập tức sau donation (realtime).
 * Mục đích: sau khi donation được ghi nhận thành công (indexed), tính QF score và ghi vào ranking
 * ngay lập tức thay vì chờ cron job 5 phút, đảm bảo Top QF luôn phản ánh kết quả mới nhất.
 *
 * Cơ chế:
 * 1. Tính toán QF snapshot đồng bộ (không qua Bull queue).
 * 2. UPSERT vào document 'current-ranking' (rankingModel đã dùng findOneAndUpdate).
 * 3. Invalidate cache ngay lập tức — không chờ cache expire.
 *
 * Lưu ý: cần gọi đồng bộ (không await) tại donation handler để không block response.
 * Error không được throw ra ngoài — chỉ log để tránh ảnh hưởng luồng donation.
 */
export async function triggerRealtimeRankingUpdate(windowHours = 24): Promise<void> {
  try {
    await recalculateRankingSnapshot(windowHours);
    await invalidateRankingCache();
  } catch (error) {
    const errorMessage = (error instanceof Error) ? error.message : String(error);
    const existingLogger = (await import('../config/logger')).getLogger();
    existingLogger.error('Realtime ranking update thất bại sau donation.', { errorMessage });
  }
}


/** Hàm lấy snapshot ranking hiện tại có phân trang/sắp xếp. Mục đích: phục vụ API public đọc bảng xếp hạng. */
export async function getCurrentRankingSnapshotPaginated(input: Partial<RankingQueryInput>) {
  const normalizedInput = normalizeRankingQueryInput(input);
  const latestSnapshot = await findCurrentRankingSnapshot();

  if (!latestSnapshot) {
    return {
      snapshot: null,
      items: [],
      metadata: {
        totalItems: 0,
        totalPages: 1,
        currentPage: normalizedInput.page,
        pageSize: normalizedInput.limit
      }
    };
  }

  const sortedItemList = [...latestSnapshot.rankingItems].sort((leftItem, rightItem) => {
    const sortingDirection = normalizedInput.sortDirection === 'asc' ? 1 : -1;
    const comparedValue = leftItem[normalizedInput.sortBy] - rightItem[normalizedInput.sortBy];
    if (comparedValue !== 0) {
      return comparedValue * sortingDirection;
    }
    return leftItem.projectId.localeCompare(rightItem.projectId);
  });

  const totalItems = sortedItemList.length;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / normalizedInput.limit) : 1;
  const safePage = Math.min(normalizedInput.page, totalPages);
  const skipCount = (safePage - 1) * normalizedInput.limit;
  const paginatedItems = sortedItemList.slice(skipCount, skipCount + normalizedInput.limit);

  return {
    snapshot: latestSnapshot,
    items: paginatedItems,
    metadata: {
      totalItems,
      totalPages,
      currentPage: safePage,
      pageSize: normalizedInput.limit
    }
  };
}
