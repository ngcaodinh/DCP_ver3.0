import { ApplicationError } from '../utils/applicationError';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import { recordAdminAuditLog } from './audit-log.service';
import { runMongoTransaction } from '../utils/mongoTransaction';
import {
  findBeneficiaryFeedbackByIdIncludingDeleted,
  findBeneficiaryFeedbackById,
  restoreBeneficiaryFeedbackById,
  softDeleteBeneficiaryFeedbackById,
  transitionBeneficiaryFeedbackFlag,
  type BeneficiaryFeedbackModerationView
} from '../models/beneficiaryFeedbackModel';
import { invalidatePublicFeedbackStatsCache } from './publicFeedback.service';
import { getPurgeMetadata } from './flaggedFeedback.service';

export type FeedbackModerationInput = {
  feedbackId: string;
  adminId: string;
  adminRole: string;
  flagged: boolean;
  reason: string;
  requestContext?: AuditRequestContext;
};

export type FeedbackDeletionInput = {
  feedbackId: string;
  adminId: string;
  adminRole: string;
  reason: string;
  requestContext?: AuditRequestContext;
};

/**
 * Flag hoặc unflag feedback bằng state transition atomic và ghi audit cùng outcome.
 * Auto-flag từ F2 không đi qua service này nên không thể giả actor admin.
 */
export async function moderateBeneficiaryFeedback(
  input: FeedbackModerationInput
): Promise<BeneficiaryFeedbackModerationView> {
  const reason = normalizeFeedbackReason(input.reason);
  if (reason.length < 10 || reason.length > 1000) {
    throw new ApplicationError('reason phải dài từ 10 đến 1000 ký tự.', 400, 'VALIDATION_ERROR');
  }
  if (input.adminRole !== 'admin') {
    throw new ApplicationError('Chỉ admin mới được moderation feedback.', 403, 'FORBIDDEN');
  }

  const result = await runMongoTransaction(async (session) => {
    const current = session
      ? await findBeneficiaryFeedbackById(input.feedbackId, session)
      : await findBeneficiaryFeedbackById(input.feedbackId);
    if (!current) {
      throw new ApplicationError('Không tìm thấy feedback.', 404, 'NOT_FOUND');
    }
    if (current.isFlagged === input.flagged) {
      throw new ApplicationError('Feedback đã ở trạng thái yêu cầu.', 409, 'CONFLICT');
    }

    const updated = session
      ? await transitionBeneficiaryFeedbackFlag(input.feedbackId, current.isFlagged, input.flagged, session)
      : await transitionBeneficiaryFeedbackFlag(input.feedbackId, current.isFlagged, input.flagged);
    if (!updated) {
      throw new ApplicationError('Feedback vừa được moderation bởi request khác.', 409, 'CONFLICT');
    }

    await recordAdminAuditLog({
      actionId: `feedback-moderation:${input.feedbackId}:${input.flagged ? 'flag' : 'unflag'}:${updated.updatedAt.toISOString()}`,
      actorType: 'ADMIN',
      adminId: input.adminId,
      adminRole: input.adminRole,
      actionType: input.flagged ? 'FEEDBACK_FLAG' : 'FEEDBACK_UNFLAG',
      targetId: input.feedbackId,
      targetType: 'BENEFICIARY_FEEDBACK',
      reason,
      requestContext: input.requestContext,
      context: {
        feedbackId: input.feedbackId,
        projectId: updated.projectId,
        isFlaggedBefore: current.isFlagged,
        isFlaggedAfter: input.flagged,
        riskScore: updated.riskScore,
        reason
      },
      session
    });
    return updated;
  });
  invalidatePublicFeedbackStatsCache(result.projectId);
  return result;
}

/** Chuẩn hóa reason moderation/delete/restore theo cùng chính sách ký tự của API. */
export function normalizeFeedbackReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
}

/** Xoá mềm feedback đã flag, audit trước khi cập nhật và invalidate cache sau commit. */
export async function softDeleteBeneficiaryFeedback(
  input: FeedbackDeletionInput
): Promise<{ feedbackId: string; projectId: string; deletedAt: Date; purgeAfter: Date }> {
  const reason = normalizeFeedbackReason(input.reason);
  if (reason.length < 10 || reason.length > 1000) {
    throw new ApplicationError('reason phải dài từ 10 đến 1000 ký tự.', 400, 'VALIDATION_ERROR');
  }
  if (input.adminRole !== 'admin') {
    throw new ApplicationError('Chỉ admin mới được xoá feedback.', 403, 'FORBIDDEN');
  }

  const result = await runMongoTransaction(async (session) => {
    const current = session
      ? await findBeneficiaryFeedbackById(input.feedbackId, session)
      : await findBeneficiaryFeedbackById(input.feedbackId);
    if (!current) {
      const existing = session
        ? await findBeneficiaryFeedbackByIdIncludingDeleted(input.feedbackId, session)
        : await findBeneficiaryFeedbackByIdIncludingDeleted(input.feedbackId);
      if (existing?.deletedAt) {
        throw new ApplicationError('Feedback đã được xoá trước đó.', 409, 'FEEDBACK_ALREADY_DELETED');
      }
      throw new ApplicationError('Không tìm thấy feedback.', 404, 'NOT_FOUND');
    }
    if (!current.isFlagged) {
      throw new ApplicationError('Chỉ được xoá feedback đang bị flag.', 409, 'FEEDBACK_NOT_FLAGGED');
    }

    const deletedAt = new Date();
    const purgeAfter = getPurgeMetadata(deletedAt, deletedAt).purgeAfter;
    await recordAdminAuditLog({
      actionId: `feedback-deletion:${input.feedbackId}:${deletedAt.toISOString()}`,
      actorType: 'ADMIN',
      adminId: input.adminId,
      adminRole: input.adminRole,
      actionType: 'FEEDBACK_DELETE',
      targetId: input.feedbackId,
      targetType: 'BENEFICIARY_FEEDBACK',
      reason,
      requestContext: input.requestContext,
      context: {
        feedbackId: input.feedbackId,
        projectId: current.projectId,
        rating: current.rating,
        riskScore: current.riskScore,
        isFlaggedBefore: current.isFlagged,
        source: current.source,
        submittedAt: current.submittedAt.toISOString(),
        purgeAfter: purgeAfter.toISOString(),
        reason
      },
      session
    });

    const deleted = session
      ? await softDeleteBeneficiaryFeedbackById(input.feedbackId, deletedAt, input.adminId, reason, session)
      : await softDeleteBeneficiaryFeedbackById(input.feedbackId, deletedAt, input.adminId, reason);
    if (!deleted) {
      throw new ApplicationError('Feedback vừa được xử lý bởi request khác.', 409, 'CONFLICT');
    }
    return { feedbackId: deleted.feedbackId, projectId: deleted.projectId, deletedAt, purgeAfter };
  });

  invalidatePublicFeedbackStatsCache(result.projectId);
  return result;
}

/** Khôi phục feedback đã xoá mềm trước hạn và vẫn giữ isFlagged=true. */
export async function restoreBeneficiaryFeedback(
  input: FeedbackDeletionInput
): Promise<{ feedbackId: string; projectId: string; isFlagged: true; restoredAt: Date }> {
  const reason = normalizeFeedbackReason(input.reason);
  if (reason.length < 10 || reason.length > 1000) {
    throw new ApplicationError('reason phải dài từ 10 đến 1000 ký tự.', 400, 'VALIDATION_ERROR');
  }
  if (input.adminRole !== 'admin') {
    throw new ApplicationError('Chỉ admin mới được khôi phục feedback.', 403, 'FORBIDDEN');
  }

  const result = await runMongoTransaction(async (session) => {
    const current = session
      ? await findBeneficiaryFeedbackByIdIncludingDeleted(input.feedbackId, session)
      : await findBeneficiaryFeedbackByIdIncludingDeleted(input.feedbackId);
    if (!current) {
      throw new ApplicationError('Feedback đã quá hạn 30 ngày và bị xoá vĩnh viễn.', 404, 'NOT_FOUND');
    }
    if (!current.deletedAt) {
      throw new ApplicationError('Feedback này chưa bị xoá.', 409, 'FEEDBACK_NOT_DELETED');
    }

    const restoredAt = new Date();
    const purgeMetadata = getPurgeMetadata(current.deletedAt, restoredAt);
    if (!purgeMetadata.isRestorable) {
      throw new ApplicationError('Feedback đã quá hạn 30 ngày và bị xoá vĩnh viễn.', 404, 'NOT_FOUND');
    }
    const daysBeforePurge = purgeMetadata.daysUntilPurge;
    await recordAdminAuditLog({
      actionId: `feedback-restore:${input.feedbackId}:${restoredAt.toISOString()}`,
      actorType: 'ADMIN',
      adminId: input.adminId,
      adminRole: input.adminRole,
      actionType: 'FEEDBACK_RESTORE',
      targetId: input.feedbackId,
      targetType: 'BENEFICIARY_FEEDBACK',
      reason,
      requestContext: input.requestContext,
      context: {
        feedbackId: input.feedbackId,
        projectId: current.projectId,
        riskScore: current.riskScore,
        deletedAt: current.deletedAt.toISOString(),
        deletedByAdminId: current.deletedByAdminId,
        daysBeforePurge,
        reason
      },
      session
    });

    const restored = session
      ? await restoreBeneficiaryFeedbackById(input.feedbackId, session)
      : await restoreBeneficiaryFeedbackById(input.feedbackId);
    if (!restored) {
      throw new ApplicationError('Feedback vừa được khôi phục hoặc purge bởi request khác.', 409, 'CONFLICT');
    }
    return { feedbackId: restored.feedbackId, projectId: restored.projectId, isFlagged: true as const, restoredAt };
  });

  invalidatePublicFeedbackStatsCache(result.projectId);
  return result;
}
