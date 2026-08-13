import { getLogger } from '../config/logger';
import { RankingProjectItem } from '../models/rankingModel';
import { ProjectIncrementalMetrics } from '../models/rankingIncrementalModel';
import {
  findAllProjectMetricsFromRepository,
  findDonationsForProjectInWindow,
  upsertProjectMetricsFromRepository
} from '../repositories/rankingIncrementalRepository';
import { findAllProjectsByIds, findCurrentRankingSnapshot } from '../repositories/rankingRepository';
import { invalidateRankingCache } from './rankingCacheService';
import { normalizeScoreNumber } from './rankingService';
import { findAuditsForProjectInWindow } from '../repositories/anonymousDonationAuditRepository';

const logger = getLogger();

/** Mức tin cậy mặc định cho guest donation khi không tìm thấy audit record. Dùng mức MEDIUM (0.5) thay vì CRITICAL (0.2) vì đây là fallback conservative — audit có thể bị delay chứ không phải bị mất. */
const DEFAULT_GUEST_TRUST_MULTIPLIER = 0.5;

/**
 * Hàm tính QF score từ running totals (O(1)).
 * Mục đích: không cần query donations, chỉ cần đọc 1 row metrics để tính score.
 *
 * Công thức QF:
 *   QF_Score = (Σ√dᵢ)²
 *   Matching = max(QF_Score - totalRaisedAmount, 0)
 *   TotalScore = totalRaisedAmount + Matching
 *
 * Trust weighting: Dùng weightedSumSqrtDonations khi nó được populate (tức project đã có
 * guest donations được tích lũy với trustMultiplier < 1.0, HOẶC toàn bộ là registered donations
 * với trustMultiplier = 1.0 — cả hai trường hợp đều > 0).
 * Fallback về sumSqrtDonations khi weightedSumSqrtDonations = 0 — chỉ xảy ra với
 * legacy records tạo trước khi Task 6.1 deploy (backward compatibility).
 */
export function computeQFScoreFromMetrics(metrics: ProjectIncrementalMetrics): {
  quadraticScoreRaw: number;
  matchingAmount: number;
  totalFundingScore: number;
} {
  const sumSqrt = metrics.weightedSumSqrtDonations > 0
    ? metrics.weightedSumSqrtDonations
    : metrics.sumSqrtDonations;
  const quadraticScoreRaw = normalizeScoreNumber(sumSqrt * sumSqrt);
  const matchingAmount = normalizeScoreNumber(Math.max(quadraticScoreRaw - metrics.totalRaisedAmount, 0));
  const totalFundingScore = normalizeScoreNumber(metrics.totalRaisedAmount + matchingAmount);
  return { quadraticScoreRaw, matchingAmount, totalFundingScore };
}

/**
 * Hàm cập nhật metrics TĂNG khi có donation mới (O(1)).
 * Mục đích: thay thế full recalculateRankingSnapshot(), chỉ cần 1 MongoDB update operation.
 *
 * @param projectId - ID của project được donation
 * @param amount - Số lượng token donate
 * @param donorAddress - Địa chỉ ví donor
 * @param trustMultiplier - Hệ số tin cậy (mặc định 1.0). Giá trị < 1.0 nghĩa là donation ẩn danh từ guest wallet.
 *                        trustMultiplier ảnh hưởng đến weightedSumSqrtDonations dùng trong QF chính thức.
 */
export async function applyDonationToMetrics(
  projectId: string,
  amount: number,
  donorAddress: string,
  trustMultiplier: number = 1.0
): Promise<void> {
  // Guard: validate inputs trước khi xử lý
  if (!projectId || !donorAddress) {
    logger.warn('applyDonationToMetrics skipped: missing projectId or donorAddress');
    return;
  }
  if (amount < 0 || !Number.isFinite(amount)) {
    logger.warn('applyDonationToMetrics skipped: invalid amount.', {
      amount,
      projectId
    });
    return;
  }
  // trustMultiplier phải nằm trong khoảng [0, 1] — clamp về 1.0 nếu invalid
  const safeMultiplier = (trustMultiplier >= 0 && trustMultiplier <= 1.0 && Number.isFinite(trustMultiplier))
    ? trustMultiplier
    : 1.0;

  // Tính sqrt(amount) một lần, reuse cho cả sumSqrtDonations và weightedSumSqrtDonations
  const sqrtAmount = Math.sqrt(amount);
  const lowerCaseAddress = donorAddress.toLowerCase();
  const now = new Date();
  const isGuestDonation = safeMultiplier < 1.0;

  await upsertProjectMetricsFromRepository(projectId, {
    $inc: {
      totalRaisedAmount: amount,
      sumSqrtDonations: sqrtAmount,
      totalDonationCount: 1,
      weightedSumSqrtDonations: sqrtAmount * safeMultiplier,
      ...(isGuestDonation
        ? { guestDonationCount: 1 }
        : {}),
    },
    $addToSet: { donorAddresses: lowerCaseAddress },
    $set: {
      lastDonationAt: now,
      updatedAt: now
    }
  });

  logger.info('Incremental metrics updated.', {
    projectId,
    amount,
    donorAddress: lowerCaseAddress,
    trustMultiplier: safeMultiplier,
    isGuestDonation
  });
}

/**
 * Hàm đánh dấu project cần full recompute.
 * Mục đích: khi donation bị xóa hoặc sybil thay đổi, không xử lý ngay mà chỉ đánh dấu.
 * Reconciler sẽ xử lý định kỳ hoặc admin trigger.
 */
export async function markProjectForRecompute(projectId: string): Promise<void> {
  const now = new Date();

  // Đánh dấu bằng cách reset recompute timestamp để reconciler biết project này cần recompute.
  await upsertProjectMetricsFromRepository(projectId, {
    $set: {
      lastFullRecomputeAt: null,
      updatedAt: now
    }
  });

  logger.info(`Project ${projectId} marked for full recompute.`);
}

/**
 * Hàm full recompute metrics cho MỘT PROJECT cụ thể (O(D_project) với D_project = donations của project đó).
 * Mục đích: khi phát hiện drift, donation bị xóa, hoặc sybil thay đổi.
 * Chỉ query donations của project cụ thể, không phải toàn bộ hệ thống.
 * Đặc biệt: rebuild weightedSumSqrtDonations từ AnonymousDonationAudit records để
 * preserve trust weighting data khi reconciler chạy.
 *
 * @param projectId - ID của project cần recompute
 * @param windowHours - Cửa sổ thời gian tính toán (mặc định 720 giờ = 30 ngày)
 */
export async function recomputeProjectMetrics(
  projectId: string,
  windowHours = 720
): Promise<ProjectIncrementalMetrics> {
  // Guard: windowHours phải dương và không quá 8760 giờ (1 năm)
  const safeWindowHours = Math.min(Math.max(windowHours, 1), 8760);
  const windowEndedAt = new Date();
  const windowStartedAt = new Date(windowEndedAt.getTime() - safeWindowHours * 60 * 60 * 1000);

  // Chỉ query donations của project này — không phải toàn bộ donations
  const donations = await findDonationsForProjectInWindow(projectId, windowStartedAt, windowEndedAt);

  // Query audit records trong cùng window — lọc ở Database layer để tránh load toàn bộ vào RAM
  const windowAudits = await findAuditsForProjectInWindow(projectId, windowStartedAt, windowEndedAt);

  // Build map: walletAddress → trustMultiplier từ audit records mới nhất.
  // Dùng Map để lưu trực tiếp — last audit ghi đè (có trustMultiplier mới nhất).
  const walletTrustMap = new Map<string, number>();
  for (const audit of windowAudits) {
    walletTrustMap.set(audit.walletAddress.toLowerCase(), audit.trustMultiplier);
  }

  let totalRaisedAmount = 0;
  let sumSqrtDonations = 0;
  let weightedSumSqrtDonations = 0;
  let guestDonationCount = 0;
  const donorSet = new Set<string>();

  for (const donation of donations) {
    // Validate amount >= 0 trước khi tính sqrt
    if (donation.amount < 0) {
      logger.warn('Skipping invalid donation amount.', {
        amount: donation.amount,
        projectId
      });
      continue;
    }

    totalRaisedAmount += donation.amount;
    const sqrtAmount = Math.sqrt(donation.amount);
    sumSqrtDonations += sqrtAmount;

    const lowerAddress = donation.donorAddress.toLowerCase();
    donorSet.add(lowerAddress);

    // Luôn tích lũy weightedSumSqrtDonations cho mọi donation — guest hoặc registered.
    // Guest: trustMultiplier < 1.0 (từ audit record). Registered: trustMultiplier = 1.0.
    // Nếu audit record không tìm thấy → fallback DEFAULT_GUEST_TRUST_MULTIPLIER.
    const trustMultiplier = donation.isAnonymous
      ? (walletTrustMap.get(lowerAddress) ?? DEFAULT_GUEST_TRUST_MULTIPLIER)
      : 1.0;
    weightedSumSqrtDonations += sqrtAmount * trustMultiplier;

    if (donation.isAnonymous) {
      guestDonationCount += 1;
    }
  }

  const now = new Date();
  const updatedMetrics = await upsertProjectMetricsFromRepository(projectId, {
    $inc: { recomputeVersion: 1 },
    $set: {
      totalRaisedAmount,
      sumSqrtDonations,
      weightedSumSqrtDonations,
      donorAddresses: Array.from(donorSet),
      totalDonationCount: donations.length,
      guestDonationCount,
      lastDonationAt: donations.length > 0 ? donations[0].timestamp : null,
      lastFullRecomputeAt: now,
      updatedAt: now
    }
  });

  logger.info('Project full recomputed.', {
    projectId,
    totalAmount: totalRaisedAmount,
    totalDonors: donorSet.size,
    totalDonationRecords: donations.length,
    weightedSumSqrtDonations,
    guestDonationCount
  });
  return updatedMetrics;
}

/**
 * Hàm rebuild incremental metrics từ snapshot cũ (one-time migration).
 * Mục đích: khi khởi động server lần đầu mà chưa có incremental metrics,
 * hàm này đọc dữ liệu từ rankingSnapshot để populate ProjectIncrementalMetrics.
 *
 * Lưu ý:
 * - snapshot cũ không chứa trust data nên weightedSumSqrtDonations = 0 và guestDonationCount = 0.
 * - QF score fallback về sumSqrtDonations.
 * - sumSqrtDonations dùng Math.sqrt(totalRaisedAmount) — ước lượng THẤP hơn thực tế
 *   (vd: 4 donations × 25 tokens → thực tế Σ√dᵢ = 20, nhưng √100 = 10).
 *   Đây là fallback CHẤP NHẬN ĐƯỢC cho migration 1 lần. Reconciliation worker
 *   sẽ recompute chính xác từ AnonymousDonationAudit records sau khi chạy.
 * - recomputeVersion = 1 đánh dấu record mới — reconciliation worker sẽ tăng bằng $inc.
 *
 * @param snapshot - ranking snapshot từ collection cũ
 */
async function rebuildIncrementalMetricsFromSnapshot(snapshot: { rankingItems: Array<{ projectId: string; totalRaisedAmount: number; uniqueDonorCount: number; totalFundingScore: number }> }): Promise<void> {
  logger.info('Bắt đầu rebuild incremental metrics từ snapshot cũ.');

  for (const item of snapshot.rankingItems) {
    try {
      await upsertProjectMetricsFromRepository(item.projectId, {
        $set: {
          totalRaisedAmount: item.totalRaisedAmount,
          sumSqrtDonations: Math.sqrt(item.totalRaisedAmount), // Ước lượng từ totalRaisedAmount
          weightedSumSqrtDonations: 0,
          donorAddresses: [],                                   // Không có trong snapshot cũ
          totalDonationCount: item.uniqueDonorCount,          // Dùng donorCount thay thế
          guestDonationCount: 0,
          lastDonationAt: null,
          lastFullRecomputeAt: new Date(),
          recomputeVersion: 1,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error(`Rebuild incremental metrics cho project ${item.projectId} thất bại.`, {
        errorMessage: (error as Error).message
      });
    }
  }

  logger.info(`Rebuild incremental metrics từ snapshot hoàn tất (${snapshot.rankingItems.length} projects).`);
}

/**
 * Hàm đọc bảng xếp hạng từ incremental metrics (O(P) với P = số project).
 * Mục đích: thay thế recalculateRankingSnapshot() cho đọc thông thường.
 *
 * Fallback logic:
 *   1. Đọc từ incremental metrics — nếu có data thì trả về ngay
 *   2. Nếu empty → đọc từ rankingSnapshot (backward compatibility)
 *   3. Nếu snapshot tồn tại → rebuild incremental metrics từ snapshot rồi trả về
 *   4. Nếu cả hai đều không có → trả về mảng rỗng
 *
 * So sánh hiệu năng:
 *   Before: Query N donations × M projects mỗi lần đọc
 *   After:  Query M rows metrics (1 doc/project)
 */
export async function getRankingFromIncrementalMetrics(): Promise<RankingProjectItem[]> {
  const allMetrics = await findAllProjectMetricsFromRepository();

  // Fallback: nếu chưa có incremental metrics → thử đọc từ snapshot cũ và rebuild
  if (!allMetrics.length) {
    logger.info('Không có incremental metrics. Thử đọc từ rankingSnapshot để rebuild.');
    const snapshot = await findCurrentRankingSnapshot();
    if (snapshot && snapshot.rankingItems && snapshot.rankingItems.length > 0) {
      await rebuildIncrementalMetricsFromSnapshot(snapshot);
      await invalidateRankingCache();
      // Sau khi rebuild → đọc lại từ incremental metrics
      const rebuiltMetrics = await findAllProjectMetricsFromRepository();
      if (rebuiltMetrics.length) {
        return buildRankingItemsFromMetrics(rebuiltMetrics);
      }
    }
    return [];
  }

  return buildRankingItemsFromMetrics(allMetrics);
}

/**
 * Hàm helper xây dựng ranking items từ metrics list.
 * Tách riêng để reuse cho cả flow chính và flow rebuild từ snapshot.
 *
 * @param allMetrics - danh sách ProjectIncrementalMetrics đã đọc từ DB
 */
async function buildRankingItemsFromMetrics(allMetrics: ProjectIncrementalMetrics[]): Promise<RankingProjectItem[]> {
  // Lấy danh sách projectId để lookup tên (async)
  const projectIdList = allMetrics.map(m => m.projectId);
  const projectRecords = await findAllProjectsByIds(projectIdList);
  const projectNameMap = new Map(projectRecords.map(p => [p.projectId, p.name]));
  const projectOrgMap = new Map(projectRecords.map(p => [p.projectId, p.organizationId]));

  // Lọc bỏ project không có donation (totalDonationCount = 0)
  const rankedItems = allMetrics
    .filter(metrics => metrics.totalDonationCount > 0)
    .map((metrics): RankingProjectItem => {
      const { quadraticScoreRaw, matchingAmount, totalFundingScore } = computeQFScoreFromMetrics(metrics);
      const projectName = projectNameMap.get(metrics.projectId) || metrics.projectId;
      const organizationId = projectOrgMap.get(metrics.projectId) || '';

      return {
        projectId: metrics.projectId,
        projectName,
        organizationName: organizationId,
        rankPosition: 0,
        totalRaisedAmount: metrics.totalRaisedAmount,
        uniqueDonorCount: metrics.donorAddresses.length > 0 ? metrics.donorAddresses.length : metrics.totalDonationCount,
        quadraticScoreRaw,
        matchingAmount,
        totalFundingScore
      };
    })
    .sort((a, b) => b.totalFundingScore - a.totalFundingScore);

  rankedItems.forEach((item, index) => { item.rankPosition = index + 1; });

  return rankedItems;
}

/**
 * Hàm reconcile tất cả project (chạy 1 lần/ngày).
 * Mục đích: ngăn incremental metrics drift theo thời gian, xử lý trường hợp
 * edge case bị miss (deletion, sybil change).
 *
 * @param windowHours - Cửa sổ thời gian tính toán (mặc định 720 giờ = 30 ngày)
 */
export async function reconcileAllProjectMetrics(windowHours = 720): Promise<void> {
  const allMetrics = await findAllProjectMetricsFromRepository();

  if (!allMetrics.length) {
    logger.info('Không có project metrics nào để reconcile.');
    return;
  }

  logger.info(`Bắt đầu reconcile ${allMetrics.length} projects.`);

  for (const metrics of allMetrics) {
    try {
      await recomputeProjectMetrics(metrics.projectId, windowHours);
    } catch (error) {
      logger.error(`Reconcile project ${metrics.projectId} thất bại.`, {
        errorMessage: (error as Error).message
      });
    }
  }

  await invalidateRankingCache();
  logger.info('Reconcile hoàn tất.');
}
