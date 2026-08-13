import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { extractAuditRequestContext } from '../utils/auditRequestContext';
import { moderateBeneficiaryFeedback } from '../services/feedbackModeration.service';

/** Xử lý POST flag/unflag feedback dành riêng cho admin. */
export async function handleFeedbackModeration(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const user = request.authenticatedUser;
  const feedbackId = request.params.feedbackId?.trim();
  const reason = typeof request.body?.reason === 'string' ? request.body.reason : '';
  const flagged = request.params.action === 'flag';
  if (!user || !feedbackId || !['flag', 'unflag'].includes(request.params.action)) {
    sendErrorResponse(response, 400, 'Thông tin moderation feedback không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const feedback = await moderateBeneficiaryFeedback({
      feedbackId,
      adminId: user.userId,
      adminRole: user.role,
      flagged,
      reason,
      requestContext: extractAuditRequestContext(request)
    });
    sendSuccessResponse(response, 200, flagged ? 'Đã flag feedback.' : 'Đã unflag feedback.', {
      feedbackId: feedback.feedbackId,
      isFlagged: feedback.isFlagged
    });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể moderation feedback.');
  }
}
