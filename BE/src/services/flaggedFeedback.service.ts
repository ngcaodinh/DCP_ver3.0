import { findProjectNamesByProjectIdList } from '../models/projectModel';
import {
  countFlaggedBeneficiaryFeedback,
  listFlaggedBeneficiaryFeedback,
  type FlaggedFeedbackQuery,
  type BeneficiaryFeedbackFlaggedView
} from '../models/beneficiaryFeedbackModel';
import { findLatestFlagAuditsByFeedbackIds } from '../models/adminAuditLogModel';
import { RISK_SCORE_AUTO_FLAG_THRESHOLD, analyzeFeedbackIndicators } from './feedbackSpamDetection.service';
import { FEEDBACK_SOFT_DELETE_RETENTION_DAYS } from './feedbackRetention.constants';
import type { FlaggedFeedbackListQuery } from '../validators/flaggedFeedback.validator';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type FlagReasonKind = 'AUTO' | 'MANUAL' | 'UNKNOWN';

export interface FlagReason {
  kind: FlagReasonKind;
  indicators: string[];
  adminReason: string | null;
  flaggedByAdminId: string | null;
  flaggedAt: string | null;
}

export interface FlaggedFeedbackItem {
  feedbackId: string;
  projectId: string;
  projectName: string | null;
  rating: number;
  comment: string;
  submittedAt: Date;
  location?: string;
  riskScore: number;
  isFlagged: boolean;
  source: 'batch' | 'public';
  flagReason: FlagReason;
  deletedAt?: Date;
  deletedByAdminId?: string;
  deleteReason?: string;
  purgeAfter?: Date;
  daysUntilPurge?: number;
  isRestorable?: boolean;
}

export interface FlaggedFeedbackListResult {
  items: FlaggedFeedbackItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Tính thời hạn purge và số ngày còn lại theo đồng hồ của backend. */
export function getPurgeMetadata(
  deletedAt: Date,
  now: Date
): { purgeAfter: Date; daysUntilPurge: number; isRestorable: boolean } {
  const purgeAfter = new Date(deletedAt.getTime() + FEEDBACK_SOFT_DELETE_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  return {
    purgeAfter,
    daysUntilPurge: Math.max(0, Math.floor((purgeAfter.getTime() - now.getTime()) / MILLISECONDS_PER_DAY)),
    isRestorable: purgeAfter.getTime() > now.getTime()
  };
}

/** Ghép project name, audit flag mới nhất và metadata xoá thành DTO an toàn cho FE. */
function toFlaggedFeedbackItem(
  feedback: BeneficiaryFeedbackFlaggedView,
  projectName: string | null,
  latestFlagAudit: {
    createdAt: Date;
    reason?: string | null;
    adminId?: string | null;
    adminUserId?: string | null;
    context?: Record<string, unknown>;
  } | undefined,
  now: Date
): FlaggedFeedbackItem {
  const indicators = analyzeFeedbackIndicators(feedback.rating, feedback.comment).indicators;
  const flagReason: FlagReason = latestFlagAudit
    ? {
        kind: 'MANUAL',
        indicators,
        adminReason: latestFlagAudit.reason ?? asString(latestFlagAudit.context?.reason),
        flaggedByAdminId: latestFlagAudit.adminId ?? latestFlagAudit.adminUserId ?? null,
        flaggedAt: toIsoString(latestFlagAudit.createdAt)
      }
    : {
        kind: feedback.riskScore >= RISK_SCORE_AUTO_FLAG_THRESHOLD ? 'AUTO' : 'UNKNOWN',
        indicators,
        adminReason: null,
        flaggedByAdminId: null,
        flaggedAt: null
      };

  const item: FlaggedFeedbackItem = {
    feedbackId: feedback.feedbackId,
    projectId: feedback.projectId,
    projectName,
    rating: feedback.rating,
    comment: feedback.comment,
    submittedAt: feedback.submittedAt,
    location: feedback.location,
    riskScore: feedback.riskScore,
    isFlagged: feedback.isFlagged,
    source: feedback.source,
    flagReason
  };

  if (feedback.deletedAt) {
    const purgeMetadata = getPurgeMetadata(feedback.deletedAt, now);
    item.deletedAt = feedback.deletedAt;
    item.deletedByAdminId = feedback.deletedByAdminId;
    item.deleteReason = feedback.deleteReason;
    item.purgeAfter = purgeMetadata.purgeAfter;
    item.daysUntilPurge = purgeMetadata.daysUntilPurge;
    item.isRestorable = purgeMetadata.isRestorable;
  }

  return item;
}

/** Liệt kê feedback cho hai tab admin với đúng ba round-trip nghiệp vụ và không phát hành PII. */
export async function listFlaggedFeedback(
  filters: FlaggedFeedbackListQuery,
  now: Date = new Date()
): Promise<FlaggedFeedbackListResult> {
  const skip = (filters.page - 1) * filters.limit;
  const query: FlaggedFeedbackQuery = {
    deletionState: filters.deletionState,
    projectId: filters.projectId,
    minRiskScore: filters.minRiskScore,
    source: filters.source,
    skip,
    limit: filters.limit
  };
  const [feedbacks, total] = await Promise.all([
    listFlaggedBeneficiaryFeedback(query),
    countFlaggedBeneficiaryFeedback(query)
  ]);

  const [projectNames, auditMap] = await Promise.all([
    findProjectNamesByProjectIdList(
      [...new Set(feedbacks.map(feedback => feedback.projectId))]
    ),
    findLatestFlagAuditsByFeedbackIds(feedbacks.map(feedback => feedback.feedbackId))
  ]);
  const projectNameMap = new Map(projectNames.map(project => [project.projectId, project.name]));

  return {
    items: feedbacks.map(feedback => toFlaggedFeedbackItem(
      feedback,
      projectNameMap.get(feedback.projectId) ?? null,
      auditMap.get(feedback.feedbackId),
      now
    )),
    page: filters.page,
    limit: filters.limit,
    total,
    totalPages: Math.ceil(total / filters.limit)
  };
}

/** Ép giá trị context về chuỗi để không làm lộ object động lên response admin. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Chuẩn hóa timestamp audit về ISO; dữ liệu legacy lỗi thời gian được coi là không xác định. */
function toIsoString(value: Date | string | undefined): string | null {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
