import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { sendSuccessResponse, sendErrorFromUnknown, sendErrorResponse } from '../utils/apiResponse';
import {
  getPendingManualReview,
  getPendingManualReviewCounts,
  getManualReviewDetail,
  manualApprove,
  manualReject
} from '../services/manualReviewService';
import {
  manualReviewParamsSchema,
  manualReviewDetailQuerySchema,
  manualReviewPendingQuerySchema,
  manualReviewRejectBodySchema
} from '../validators/manualReviewValidator';

/**
 * GET /api/disbursements/pending-review
 * Mục đích: lấy danh sách queue manual review pending có phân trang và DTO an toàn.
 */
export async function handleGetPendingManualReview(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const queryResult = manualReviewPendingQuerySchema.safeParse(request.query);
  if (!queryResult.success) {
    sendErrorResponse(response, 400, 'Query pending-review không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const page = await getPendingManualReview(queryResult.data);
    sendSuccessResponse(response, 200, 'Lấy danh sách pending review thành công.', page);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách pending review.');
  }
}

/**
 * GET /api/disbursements/pending-review/counts
 * Mục đích: lấy toàn bộ count của dashboard bằng một aggregate server-side.
 */
export async function handleGetPendingManualReviewCounts(
  _request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  try {
    const counts = await getPendingManualReviewCounts();
    sendSuccessResponse(response, 200, 'Lấy tổng pending review thành công.', counts);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy tổng pending review.');
  }
}

/**
 * GET /api/disbursements/:id/detail
 * Mục đích: chi tiết một disbursement MANUAL_REVIEW kèm transfer logs và audit logs đã mask PII.
 */
export async function handleGetManualReviewDetail(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Chưa xác thực.', 'UNAUTHORIZED');
    return;
  }

  const paramsResult = manualReviewParamsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    sendErrorResponse(response, 400, 'Thiếu request ID.', 'VALIDATION_ERROR');
    return;
  }

  const queryResult = manualReviewDetailQuerySchema.safeParse(request.query);
  if (!queryResult.success) {
    sendErrorResponse(response, 400, 'Query detail manual review không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const detail = await getManualReviewDetail(paramsResult.data.id, {
      revealBankAccount: queryResult.data.revealBankAccount,
      adminUserId: request.authenticatedUser?.userId
    });
    sendSuccessResponse(response, 200, 'Lấy chi tiết manual review thành công.', detail);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết manual review.');
  }
}

/**
 * POST /api/disbursements/:id/manual-approve
 * Mục đích: admin chấp nhận retry PayOS; response 202 vì transfer chưa hoàn tất.
 */
export async function handleManualApprove(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Chưa xác thực.', 'UNAUTHORIZED');
    return;
  }

  const paramsResult = manualReviewParamsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    sendErrorResponse(response, 400, 'Thiếu request ID.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await manualApprove(paramsResult.data.id, request.authenticatedUser.userId);
    sendSuccessResponse(response, 202, 'Manual approve đã được chấp nhận và đẩy lại vào queue.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Manual approve thất bại.');
  }
}

/**
 * POST /api/disbursements/:id/manual-reject
 * Mục đích: admin từ chối thủ công với reason tối thiểu 10 ký tự.
 */
export async function handleManualReject(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Chưa xác thực.', 'UNAUTHORIZED');
    return;
  }

  const paramsResult = manualReviewParamsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    sendErrorResponse(response, 400, 'Thiếu request ID.', 'VALIDATION_ERROR');
    return;
  }

  const bodyResult = manualReviewRejectBodySchema.safeParse(request.body);
  if (!bodyResult.success) {
    sendErrorResponse(response, 400, 'reason phải dài từ 10 đến 1000 ký tự.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await manualReject(
      paramsResult.data.id,
      request.authenticatedUser.userId,
      bodyResult.data.reason
    );
    sendSuccessResponse(response, 200, 'Manual reject thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Manual reject thất bại.');
  }
}
