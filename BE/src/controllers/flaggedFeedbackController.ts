import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { extractAuditRequestContext } from '../utils/auditRequestContext';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import {
  restoreBeneficiaryFeedback,
  softDeleteBeneficiaryFeedback
} from '../services/feedbackModeration.service';
import { listFlaggedFeedback } from '../services/flaggedFeedback.service';
import {
  feedbackDeleteBodySchema,
  flaggedFeedbackListQuerySchema
} from '../validators/flaggedFeedback.validator';

/** Trả danh sách feedback admin theo tab, filter và pagination đã validate. */
export async function handleListFlaggedFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const parsedQuery = flaggedFeedbackListQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) {
    sendErrorResponse(response, 400, 'Query feedback bị flag không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await listFlaggedFeedback(parsedQuery.data);
    sendSuccessResponse(response, 200, 'Lấy danh sách feedback bị flag thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách feedback bị flag.');
  }
}

/** Xoá mềm feedback đã flag và giữ audit trail trong transaction. */
export async function handleDeleteFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const user = request.authenticatedUser;
  const feedbackId = request.params.feedbackId?.trim();
  const parsedBody = feedbackDeleteBodySchema.safeParse(request.body);
  if (!user || !feedbackId || !parsedBody.success) {
    sendErrorResponse(response, 400, 'Thông tin xoá feedback không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await softDeleteBeneficiaryFeedback({
      feedbackId,
      adminId: user.userId,
      adminRole: user.role,
      reason: parsedBody.data.reason,
      requestContext: extractAuditRequestContext(request)
    });
    sendSuccessResponse(response, 200, 'Đã xoá mềm feedback.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể xoá feedback.');
  }
}

/** Khôi phục feedback trong cửa sổ 30 ngày và giữ nguyên trạng thái bị flag. */
export async function handleRestoreFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const user = request.authenticatedUser;
  const feedbackId = request.params.feedbackId?.trim();
  const parsedBody = feedbackDeleteBodySchema.safeParse(request.body);
  if (!user || !feedbackId || !parsedBody.success) {
    sendErrorResponse(response, 400, 'Thông tin khôi phục feedback không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await restoreBeneficiaryFeedback({
      feedbackId,
      adminId: user.userId,
      adminRole: user.role,
      reason: parsedBody.data.reason,
      requestContext: extractAuditRequestContext(request)
    });
    sendSuccessResponse(response, 200, 'Đã khôi phục feedback.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể khôi phục feedback.');
  }
}
