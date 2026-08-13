import { ApplicationError } from '../utils/applicationError';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import { recordAdminAuditLog } from './audit-log.service';
import { runMongoTransaction } from '../utils/mongoTransaction';
import {
  findBeneficiaryFeedbackById,
  transitionBeneficiaryFeedbackFlag,
  type BeneficiaryFeedback
} from '../models/beneficiaryFeedbackModel';

export type FeedbackModerationInput = {
  feedbackId: string;
  adminId: string;
  adminRole: string;
  flagged: boolean;
  reason: string;
  requestContext?: AuditRequestContext;
};

/**
 * Flag hoặc unflag feedback bằng state transition atomic và ghi audit cùng outcome.
 * Auto-flag từ F2 không đi qua service này nên không thể giả actor admin.
 */
export async function moderateBeneficiaryFeedback(
  input: FeedbackModerationInput
): Promise<BeneficiaryFeedback> {
  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new ApplicationError('reason phải dài từ 10 đến 1000 ký tự.', 400, 'VALIDATION_ERROR');
  }
  if (input.adminRole !== 'admin') {
    throw new ApplicationError('Chỉ admin mới được moderation feedback.', 403, 'FORBIDDEN');
  }

  return runMongoTransaction(async (session) => {
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
}
