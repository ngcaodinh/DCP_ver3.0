import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { listOrganizationFeedback } from '../services/organizationFeedback.service';
import { organizationFeedbackListQuerySchema } from '../validators/organizationFeedback.validator';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

/** Trả danh sách feedback của tổ chức hiện tại sau khi validate filter tại boundary. */
export async function handleListOrganizationFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const parsedQuery = organizationFeedbackListQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) {
    sendErrorResponse(response, 400, 'Query feedback của tổ chức không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  const organizationId = request.authenticatedUser?.userId;
  if (!organizationId) {
    sendErrorResponse(response, 401, 'Thiếu thông tin xác thực người dùng.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const result = await listOrganizationFeedback(parsedQuery.data, organizationId);
    sendSuccessResponse(response, 200, 'Lấy danh sách feedback của tổ chức thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách feedback của tổ chức.');
  }
}
