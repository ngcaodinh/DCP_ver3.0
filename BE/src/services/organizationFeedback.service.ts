import { findProjectNamesByProjectIdList } from '../models/projectModel';
import {
  BeneficiaryFeedbackModel,
  type BeneficiaryFeedback
} from '../models/beneficiaryFeedbackModel';
import type { OrganizationFeedbackListQuery } from '../validators/organizationFeedback.validator';

/** DTO an toàn được phép trả về cho màn hình quản lý feedback của tổ chức. */
export interface OrganizationFeedbackItem {
  feedbackId: string;
  projectId: string;
  projectName: string | null;
  rating: number;
  comment: string;
  submittedAt: Date;
  location?: string;
  source: 'batch' | 'public';
  isFlagged: boolean;
}

/** Thống kê feedback theo đúng predicate đang áp dụng, không phụ thuộc phân trang. */
export interface OrganizationFeedbackStats {
  totalCount: number;
  visibleCount: number;
  pendingCount: number;
  avgRating: number | null;
  distribution: Record<string, number>;
}

/** Response phân trang và thống kê cho endpoint organization feedback. */
export interface OrganizationFeedbackListResult {
  items: OrganizationFeedbackItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  stats: OrganizationFeedbackStats;
}

type OrganizationFeedbackView = Pick<
  BeneficiaryFeedback,
  'feedbackId' | 'projectId' | 'rating' | 'comment' | 'submittedAt' | 'location' | 'source' | 'isFlagged'
>;

const ORGANIZATION_FEEDBACK_PROJECTION = {
  _id: 0,
  feedbackId: 1,
  projectId: 1,
  rating: 1,
  comment: 1,
  submittedAt: 1,
  location: 1,
  source: 1,
  isFlagged: 1
} as const;

/** Dựng một predicate duy nhất cho cả truy vấn danh sách và aggregate thống kê. */
function buildOrganizationFeedbackPredicate(
  organizationId: string,
  filters: OrganizationFeedbackListQuery
): Record<string, unknown> {
  const predicate: Record<string, unknown> = {
    uploadedByOrganizationId: organizationId,
    deletedAt: null
  };

  if (filters.projectId) {
    predicate.projectId = filters.projectId;
  }
  if (filters.source) {
    predicate.source = filters.source;
  }
  if (filters.moderationState === 'visible') {
    predicate.isFlagged = false;
  }
  if (filters.moderationState === 'pending') {
    predicate.isFlagged = true;
  }

  return predicate;
}

/** Chuyển kết quả aggregate MongoDB thành stats ổn định cho cả dữ liệu rỗng. */
function normalizeOrganizationFeedbackStats(
  aggregateResult: Array<{
    totalCount?: number;
    visibleCount?: number;
    pendingCount?: number;
    avgRating?: number;
    rating1?: number;
    rating2?: number;
    rating3?: number;
    rating4?: number;
    rating5?: number;
  }>
): OrganizationFeedbackStats {
  const stats = aggregateResult[0];
  if (!stats || !stats.totalCount) {
    return {
      totalCount: 0,
      visibleCount: 0,
      pendingCount: 0,
      avgRating: null,
      distribution: {}
    };
  }

  return {
    totalCount: stats.totalCount,
    visibleCount: stats.visibleCount ?? 0,
    pendingCount: stats.pendingCount ?? 0,
    avgRating: stats.avgRating === undefined ? null : Math.round(stats.avgRating * 100) / 100,
    distribution: {
      '1': stats.rating1 ?? 0,
      '2': stats.rating2 ?? 0,
      '3': stats.rating3 ?? 0,
      '4': stats.rating4 ?? 0,
      '5': stats.rating5 ?? 0
    }
  };
}

/** Liệt kê feedback của đúng tổ chức kèm stats bằng projection allowlist và tối đa ba round-trip. */
export async function listOrganizationFeedback(
  filters: OrganizationFeedbackListQuery,
  organizationId: string
): Promise<OrganizationFeedbackListResult> {
  const predicate = buildOrganizationFeedbackPredicate(organizationId, filters);
  const aggregateResult = await BeneficiaryFeedbackModel.aggregate([
    { $match: predicate },
    {
      $group: {
        _id: null,
        totalCount: { $sum: 1 },
        visibleCount: { $sum: { $cond: [{ $eq: ['$isFlagged', false] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $eq: ['$isFlagged', true] }, 1, 0] } },
        avgRating: { $avg: '$rating' },
        rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
        rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } }
      }
    }
  ]);
  const stats = normalizeOrganizationFeedbackStats(aggregateResult);
  const totalPages = Math.ceil(stats.totalCount / filters.limit);
  const page = totalPages === 0 ? 1 : Math.min(filters.page, totalPages);
  const skip = (page - 1) * filters.limit;

  const feedbacks = await BeneficiaryFeedbackModel.find(predicate)
    .select(ORGANIZATION_FEEDBACK_PROJECTION)
    .sort({ submittedAt: -1, feedbackId: -1 })
    .skip(skip)
    .limit(filters.limit)
    .lean<OrganizationFeedbackView[]>()
    .exec();
  const projectNames = await findProjectNamesByProjectIdList(
    [...new Set(feedbacks.map(feedback => feedback.projectId))]
  );
  const projectNameMap = new Map(projectNames.map(project => [project.projectId, project.name]));

  return {
    items: feedbacks.map(feedback => ({
      feedbackId: feedback.feedbackId,
      projectId: feedback.projectId,
      projectName: projectNameMap.get(feedback.projectId) ?? null,
      rating: feedback.rating,
      comment: feedback.comment,
      submittedAt: feedback.submittedAt,
      location: feedback.location,
      source: feedback.source,
      isFlagged: feedback.isFlagged
    })),
    page,
    limit: filters.limit,
    total: stats.totalCount,
    totalPages,
    stats
  };
}
