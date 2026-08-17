/**
 * Router cho feedback API endpoints.
 * Quản lý các tuyến liên quan đến beneficiary feedback.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { batchUploadFeedbackController } from '../controllers/feedbackBatchController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { FEEDBACK_BATCH_RATE_LIMIT_CONFIG, MAX_UPLOAD_SIZE_BYTES } from '../controllers/feedbackBatchController';
import { handleFeedbackModeration } from '../controllers/feedbackModerationController';
import {
  handleDeleteFeedback,
  handleListFlaggedFeedback,
  handleRestoreFeedback
} from '../controllers/flaggedFeedbackController';
import { handleListOrganizationFeedback } from '../controllers/organizationFeedbackController';
import { sendErrorResponse } from '../utils/apiResponse';

/**
 * Giới hạn file size cho upload (tái sử dụng từ service).
 */
const MULTER_FILE_SIZE_LIMIT = MAX_UPLOAD_SIZE_BYTES;
const ORGANIZATION_FEEDBACK_READ_RATE_LIMIT_MAX_REQUESTS = 120;
const ORGANIZATION_FEEDBACK_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MULTER_FILE_SIZE_LIMIT
  }
});

/** Bọc Multer để chuyển lỗi vượt giới hạn file thành contract 4xx của batch API. */
function handleFeedbackFileUpload(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  upload.single('file')(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        sendErrorResponse(
          response,
          400,
          `File size exceeds ${MULTER_FILE_SIZE_LIMIT / (1024 * 1024)}MB limit.`,
          'FILE_TOO_LARGE'
        );
        return;
      }

      sendErrorResponse(
        response,
        400,
        error.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Yêu cầu tải lên không đúng định dạng. Vui lòng thử lại.'
          : 'Multipart request không hợp lệ.',
        error.code === 'LIMIT_UNEXPECTED_FILE' ? 'INVALID_BODY_FORMAT' : 'INVALID_BODY'
      );
      return;
    }

    next(error);
  });
}

/**
 * Tạo router cho feedback routes.
 * @returns Express Router đã configured
 */
export function createFeedbackRoutes(): Router {
  const router = Router();

  // Rate limiter cho batch upload
  const feedbackRateLimiter = createRateLimitMiddleware(
    FEEDBACK_BATCH_RATE_LIMIT_CONFIG.maxRequests,
    FEEDBACK_BATCH_RATE_LIMIT_CONFIG.windowMs,
    { bucketName: FEEDBACK_BATCH_RATE_LIMIT_CONFIG.bucketName }
  );
  const feedbackModerationRateLimiter = createRateLimitMiddleware(30, 60 * 1000, {
    bucketName: 'feedback:moderation'
  });
  const flaggedFeedbackReadRateLimiter = createRateLimitMiddleware(120, 60 * 1000, {
    bucketName: 'admin:flagged-feedback-read'
  });
  const organizationFeedbackReadRateLimiter = createRateLimitMiddleware(
    ORGANIZATION_FEEDBACK_READ_RATE_LIMIT_MAX_REQUESTS,
    ORGANIZATION_FEEDBACK_READ_RATE_LIMIT_WINDOW_MS,
    {
      bucketName: 'organization:feedback-read'
    }
  );

  // F5-A: route literal và restore phải đứng trước route có parameter để không bị nuốt.
  router.get(
    '/flagged',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    flaggedFeedbackReadRateLimiter,
    handleListFlaggedFeedback
  );

  router.get(
    '/organization',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['organizations']),
    organizationFeedbackReadRateLimiter,
    handleListOrganizationFeedback
  );

  router.post(
    '/:feedbackId/restore',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    feedbackModerationRateLimiter,
    handleRestoreFeedback
  );

  // F5/E8: chỉ admin active mới được đổi state moderation và tạo audit trail.
  router.post(
    '/:feedbackId/:action(flag|unflag)',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    feedbackModerationRateLimiter,
    handleFeedbackModeration
  );

  router.delete(
    '/:feedbackId',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    feedbackModerationRateLimiter,
    handleDeleteFeedback
  );

  /**
   * POST /api/feedback/batch
   * Batch upload feedback - CSV file hoặc JSON array.
   * 
   * Request (CSV):
   *   Content-Type: multipart/form-data
   *   Body: form-data with field 'file' containing CSV file
   * 
   * Request (JSON):
   *   Content-Type: application/json
   *   Body: { feedbacks: [...] } or [...]
   * 
   * Response:
   *   {
   *     success: number,
   *     failed: number,
   *     errors: [{rowNumber, reason}],
   *     flaggedCount: number
   *   }
   */
  router.post(
    '/batch',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['organizations', 'admin']),
    feedbackRateLimiter,
    handleFeedbackFileUpload,
    batchUploadFeedbackController
  );

  return router;
}
