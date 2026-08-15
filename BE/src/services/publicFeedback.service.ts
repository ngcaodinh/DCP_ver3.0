/**
 * Service xử lý public feedback APIs.
 * Chỉ trả về feedback không bị flag, không có PII, có pagination và caching cho stats.
 */

import { BeneficiaryFeedbackModel } from '../models/beneficiaryFeedbackModel';
import { createInMemoryCache } from '../utils/inMemoryCache';

/**
 * Thời gian cache cho stats (10 phút = 600 giây).
 */
const STATS_CACHE_TTL_SECONDS = 600;

/**
 * Tiền tố khóa cache cho thống kê.
 */
const STATS_CACHE_KEY_PREFIX = 'feedback:stats:';

/**
 * Interface cho phản hồi pagination.
 */
export interface PublicFeedbackItem {
  feedbackId: string;
  projectId: string;
  rating: number;
  comment: string;
  submittedAt: Date;
  location?: string;
}

export interface PaginationResult {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PublicFeedbackListResult {
  feedbacks: PublicFeedbackItem[];
  pagination: PaginationResult;
}

/**
 * Interface cho phản hồi stats.
 */
export interface PublicFeedbackStatsResult {
  avgRating: number | null;
  totalCount: number;
  distribution: Record<string, number>;
}

/**
 * Đối tượng cache thống kê dùng chung trong tiến trình.
 */
const statsCache = createInMemoryCache<PublicFeedbackStatsResult>();
const statsInFlight = new Map<string, Promise<PublicFeedbackStatsResult>>();
const statsCacheGenerations = new Map<string, number>();

/** Xóa cache thống kê trong bộ nhớ tiến trình sau khi project có feedback mới. */
export function invalidatePublicFeedbackStatsCache(projectId: string): void {
  const cacheKey = `${STATS_CACHE_KEY_PREFIX}${projectId}`;
  statsCacheGenerations.set(cacheKey, (statsCacheGenerations.get(cacheKey) || 0) + 1);
  statsCache.deleteByKey(cacheKey);
  statsInFlight.delete(cacheKey);
}

/**
 * Lấy danh sách feedback công khai với pagination.
 * Chỉ trả về feedback không bị flag và không bao gồm PII.
 * 
 * @param projectId ID của dự án
 * @param page Số trang (1-based)
 * @param limit Số items mỗi trang
 * @returns Danh sách feedback và thông tin pagination
 */
export async function getPublicFeedbackList(
  projectId: string,
  page: number,
  limit: number
): Promise<PublicFeedbackListResult> {
  const skip = (page - 1) * limit;

  // Chỉ truy vấn các feedback không bị gắn cờ.
  const [feedbacks, totalItems] = await Promise.all([
    BeneficiaryFeedbackModel.find({
      projectId,
      isFlagged: false
    })
      .select('-_id feedbackId projectId rating comment submittedAt location')
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    BeneficiaryFeedbackModel.countDocuments({
      projectId,
      isFlagged: false
    })
  ]);

  const totalPages = Math.ceil(totalItems / limit);

  return {
    feedbacks: feedbacks as PublicFeedbackItem[],
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    }
  };
}

/** Tổng hợp stats từ MongoDB; tách riêng để các request đồng thời dùng chung một promise. */
async function loadPublicFeedbackStats(projectId: string): Promise<PublicFeedbackStatsResult> {
  // Tổng hợp thống kê trực tiếp từ MongoDB khi cache không có dữ liệu.
  const statsResult = await BeneficiaryFeedbackModel.aggregate([
    {
      $match: {
        projectId,
        isFlagged: false
      }
    },
    {
      $group: {
        _id: null,
        totalCount: { $sum: 1 },
        avgRating: { $avg: '$rating' },
        rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
        rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } }
      }
    }
  ]);

  if (statsResult.length === 0) {
    // Không có feedback nào - trả về giá trị zero.
    return {
      avgRating: null,
      totalCount: 0,
      distribution: {}
    };
  }

  const stats = statsResult[0];
  // stats.totalCount luôn >= 1 vì $group đã aggregate non-empty buckets, nhưng defensive check vẫn an toàn.
  const roundedAverage = Math.round(stats.avgRating * 100) / 100;
  return {
    avgRating: roundedAverage,
    totalCount: stats.totalCount,
    distribution: {
      '1': stats.rating1,
      '2': stats.rating2,
      '3': stats.rating3,
      '4': stats.rating4,
      '5': stats.rating5
    }
  };
}

/**
 * Lấy thống kê feedback công khai cho một dự án.
 * Kết quả được cache trong 10 phút.
 *
 * @param projectId ID của dự án
 * @returns Thống kê: avgRating, totalCount, distribution
 */
export async function getPublicFeedbackStats(
  projectId: string
): Promise<PublicFeedbackStatsResult> {
  const cacheKey = `${STATS_CACHE_KEY_PREFIX}${projectId}`;

  // Ưu tiên cache trước khi thực hiện aggregate trên MongoDB.
  const cachedResult = statsCache.get(cacheKey);
  if (cachedResult !== null) {
    return cachedResult;
  }

  const inFlightResult = statsInFlight.get(cacheKey);
  if (inFlightResult) return inFlightResult;

  const generationAtStart = statsCacheGenerations.get(cacheKey) || 0;
  const statsPromise = loadPublicFeedbackStats(projectId);
  statsInFlight.set(cacheKey, statsPromise);

  try {
    const result = await statsPromise;
    // Không ghi đè cache bằng aggregate đã bắt đầu trước một lần submit/invalidate.
    if ((statsCacheGenerations.get(cacheKey) || 0) === generationAtStart) {
      statsCache.set(cacheKey, result, STATS_CACHE_TTL_SECONDS);
    }
    return result;
  } finally {
    if (statsInFlight.get(cacheKey) === statsPromise) {
      statsInFlight.delete(cacheKey);
    }
  }
}
