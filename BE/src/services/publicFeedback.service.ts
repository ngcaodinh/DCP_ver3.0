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
 * Cache key prefix cho stats.
 */
const STATS_CACHE_KEY_PREFIX = 'feedback:stats:';

/**
 * Interface cho phản hồi pagination.
 */
export interface PublicFeedbackItem {
  feedbackId: string;
  projectId: string;
  beneficiaryNameHash: string;
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
 * Cache instance cho stats (singleton pattern).
 */
const statsCache = createInMemoryCache<PublicFeedbackStatsResult>();

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

  // Query chỉ lấy feedback không bị flag
  const [feedbacks, totalItems] = await Promise.all([
    BeneficiaryFeedbackModel.find({
      projectId,
      isFlagged: false
    })
      .select('feedbackId projectId beneficiaryNameHash rating comment submittedAt location')
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
    feedbacks: feedbacks.map(doc => ({
      feedbackId: doc.feedbackId,
      projectId: doc.projectId,
      beneficiaryNameHash: doc.beneficiaryNameHash,
      rating: doc.rating,
      comment: doc.comment,
      submittedAt: doc.submittedAt,
      location: doc.location
    })),
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

  // Kiểm tra cache trước
  const cachedResult = statsCache.get(cacheKey);
  if (cachedResult !== null) {
    return cachedResult;
  }

  // Aggregate stats từ MongoDB
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

  let result: PublicFeedbackStatsResult;

  if (statsResult.length === 0) {
    // Không có feedback nào - trả về giá trị zero
    result = {
      avgRating: null,
      totalCount: 0,
      distribution: {}
    };
  } else {
    const stats = statsResult[0];
    result = {
      avgRating: stats.totalCount > 0 ? Math.round(stats.avgRating * 100) / 100 : null,
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

  // Lưu vào cache
  statsCache.set(cacheKey, result, STATS_CACHE_TTL_SECONDS);

  return result;
}

/**
 * Xóa cache stats cho một dự án.
 * Dùng khi có feedback mới được thêm.
 * 
 * @param projectId ID của dự án
 */
export function invalidateStatsCache(projectId: string): void {
  const cacheKey = `${STATS_CACHE_KEY_PREFIX}${projectId}`;
  statsCache.deleteByKey(cacheKey);
}
