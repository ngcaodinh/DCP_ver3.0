/**
 * Controller xử lý các API flag/unflag feedback cho admin.
 * Quản lý HTTP request và response cho feedback flagging operations.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { sendErrorResponse, sendSuccessResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import {
  getFlaggedFeedback,
  flagFeedbackManually,
  unflagFeedback,
  FeedbackNotFoundError,
  FlagValidationError
} from '../services/feedbackFlagging.service';
import { ApplicationError } from '../utils/applicationError';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Giới hạn rate limit cho admin flagging endpoints.
 */
const ADMIN_FLAG_READ_RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_FLAG_READ_MAX_REQUESTS = 60;

const ADMIN_FLAG_ACTION_RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_FLAG_ACTION_MAX_REQUESTS = 20;

/**
 * Lấy user ID từ request đã xác thực.
 * @param request Request object
 * @param response Response object
 * @returns userId hoặc null nếu không hợp lệ
 */
function getAdminUserId(request: AuthenticatedRequest, response: Response): string | null {
  const user = request.authenticatedUser;
  if (!user || !user.userId) {
    sendErrorResponse(response, 401, 'Yêu cầu xác thực admin.', 'UNAUTHENTICATED');
    return null;
  }
  return user.userId;
}

/**
 * Validate pagination query params.
 * @param query Query params object
 * @returns Validated { page, limit }
 */
function parsePaginationParams(query: Record<string, unknown>): { page: number; limit: number } {
  let page = 1;
  let limit = 20;

  if (query.page !== undefined) {
    const parsedPage = parseInt(query.page as string, 10);
    if (!isNaN(parsedPage) && parsedPage > 0) {
      page = parsedPage;
    }
  }

  if (query.limit !== undefined) {
    const parsedLimit = parseInt(query.limit as string, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      limit = parsedLimit;
    }
  }

  return { page, limit };
}

/**
 * Handler lấy danh sách feedback đã được flag.
 * Endpoint: GET /api/feedback/flagged
 * 
 * Query params:
 * - page: Số trang (default: 1)
 * - limit: Số lượng mỗi trang (default: 20, max: 50)
 * - projectId: Lọc theo project (optional)
 * - minRiskScore: Lọc theo risk score tối thiểu (optional)
 */
export async function handleGetFlaggedFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  try {
    // Validate pagination
    const { page, limit } = parsePaginationParams(request.query as Record<string, unknown>);

    if (limit > 50) {
      sendErrorResponse(response, 400, 'Limit không được vượt quá 50.', 'VALIDATION_ERROR');
      return;
    }

    if (!Number.isInteger(page) || page < 1) {
      sendErrorResponse(response, 400, 'Page phải là số nguyên dương.', 'VALIDATION_ERROR');
      return;
    }

    // Build options
    const options: {
      page: number;
      limit: number;
      projectId?: string;
      minRiskScore?: number;
    } = { page, limit };

    if (request.query.projectId && typeof request.query.projectId === 'string') {
      options.projectId = request.query.projectId;
    }

    if (request.query.minRiskScore !== undefined) {
      const minScore = parseFloat(request.query.minRiskScore as string);
      if (!isNaN(minScore) && minScore >= 0 && minScore <= 10) {
        options.minRiskScore = minScore;
      }
    }

    // Call service
    const result = await getFlaggedFeedback(options);

    logger.info('Fetched flagged feedback list', {
      adminUserId: request.authenticatedUser?.userId,
      page: result.page,
      limit: result.limit,
      total: result.total
    });

    sendSuccessResponse(
      response,
      200,
      'Lấy danh sách feedback đã flag thành công.',
      {
        items: result.items,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages
        }
      }
    );
  } catch (error: unknown) {
    logger.error('Error fetching flagged feedback', {
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách feedback đã flag.');
  }
}

/**
 * Handler flag một feedback thủ công.
 * Endpoint: POST /api/feedback/:id/flag
 * 
 * Body: { reason: string (5-500 chars) }
 */
export async function handleFlagFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const adminUserId = getAdminUserId(request, response);
  if (!adminUserId) {
    return;
  }

  try {
    const feedbackId = request.params.id;
    if (!feedbackId) {
      sendErrorResponse(response, 400, 'Feedback ID là bắt buộc.', 'VALIDATION_ERROR');
      return;
    }

    const { reason } = request.body as { reason?: string };

    // Validate reason presence
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      sendErrorResponse(response, 400, 'Lý do flag là bắt buộc.', 'VALIDATION_ERROR');
      return;
    }

    // Flag feedback
    const updatedFeedback = await flagFeedbackManually(feedbackId, adminUserId, reason);

    // Log chỉ độ dài reason thay vì raw text để giảm risk log PII nhạy cảm.
    // Admin vẫn có thể xem full reason trong flagHistory trên document hoặc DB trực tiếp.
    logger.info('Feedback flagged manually', {
      feedbackId,
      adminUserId,
      reasonLength: reason.trim().length
    });

    sendSuccessResponse(
      response,
      200,
      'Feedback đã được flag thành công.',
      {
        feedbackId: updatedFeedback.feedbackId,
        isFlagged: updatedFeedback.isFlagged,
        flagReason: updatedFeedback.flagReason,
        flaggedAt: updatedFeedback.flaggedAt,
        flaggedBy: updatedFeedback.flaggedBy
      }
    );
  } catch (error: unknown) {
    if (error instanceof FeedbackNotFoundError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    if (error instanceof FlagValidationError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    if (error instanceof ApplicationError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    logger.error('Error flagging feedback', {
      feedbackId: request.params.id,
      errorMessage: (error as Error).message
    });

    sendErrorFromUnknown(response, error, 'Không thể flag feedback.');
  }
}

/**
 * Handler unflag một feedback.
 * Endpoint: POST /api/feedback/:id/unflag
 * 
 * Body: { reason: string (5-500 ký tự) } — bắt buộc cho audit trail.
 */
export async function handleUnflagFeedback(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const adminUserId = getAdminUserId(request, response);
  if (!adminUserId) {
    return;
  }

  try {
    const feedbackId = request.params.id;
    if (!feedbackId) {
      sendErrorResponse(response, 400, 'Feedback ID là bắt buộc.', 'VALIDATION_ERROR');
      return;
    }

    const { reason } = request.body as { reason?: string };

    // Validate reason presence trước khi gọi service (tránh throw không cần thiết).
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      sendErrorResponse(response, 400, 'Lý do unflag là bắt buộc.', 'VALIDATION_ERROR');
      return;
    }

    // Unflag feedback
    const updatedFeedback = await unflagFeedback(feedbackId, adminUserId, reason);

    // Log chỉ độ dài reason thay vì raw text để giảm risk log PII nhạy cảm.
    logger.info('Feedback unflagged', {
      feedbackId,
      adminUserId,
      reasonLength: reason.trim().length
    });

    sendSuccessResponse(
      response,
      200,
      'Feedback đã được unflag thành công.',
      {
        feedbackId: updatedFeedback.feedbackId,
        isFlagged: updatedFeedback.isFlagged
      }
    );
  } catch (error: unknown) {
    if (error instanceof FeedbackNotFoundError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    if (error instanceof FlagValidationError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    if (error instanceof ApplicationError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    logger.error('Error unflagging feedback', {
      feedbackId: request.params.id,
      errorMessage: (error as Error).message
    });

    sendErrorFromUnknown(response, error, 'Không thể unflag feedback.');
  }
}

/**
 * Export rate limit config cho routes.
 */
export const FEEDBACK_FLAG_READ_RATE_LIMIT_CONFIG = {
  maxRequests: ADMIN_FLAG_READ_MAX_REQUESTS,
  windowMs: ADMIN_FLAG_READ_RATE_LIMIT_WINDOW_MS,
  bucketName: 'feedback-flag-read'
};

export const FEEDBACK_FLAG_ACTION_RATE_LIMIT_CONFIG = {
  maxRequests: ADMIN_FLAG_ACTION_MAX_REQUESTS,
  windowMs: ADMIN_FLAG_ACTION_RATE_LIMIT_WINDOW_MS,
  bucketName: 'feedback-flag-action'
};
