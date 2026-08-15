/**
 * Router cho feedback API endpoints.
 * Quản lý các tuyến liên quan đến beneficiary feedback.
 */

import { Router } from 'express';
import multer from 'multer';
import { batchUploadFeedbackController } from '../controllers/feedbackBatchController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { FEEDBACK_BATCH_RATE_LIMIT_CONFIG, MAX_UPLOAD_SIZE_BYTES } from '../controllers/feedbackBatchController';
import { handleFeedbackModeration } from '../controllers/feedbackModerationController';
import {
  handleDeleteFeedback,
  handleListFlaggedFeedback,
  handleRestoreFeedback
} from '../controllers/flaggedFeedbackController';

/**
 * Giới hạn file size cho upload (tái sử dụng từ service).
 */
const MULTER_FILE_SIZE_LIMIT = MAX_UPLOAD_SIZE_BYTES;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MULTER_FILE_SIZE_LIMIT
  }
});

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

  // F5-A: route literal và restore phải đứng trước route có parameter để không bị nuốt.
  router.get(
    '/flagged',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    flaggedFeedbackReadRateLimiter,
    handleListFlaggedFeedback
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
    createRoleAuthorizationMiddleware(['NGO_ORG', 'PROJECT_MANAGER', 'ADMIN']),
    feedbackRateLimiter,
    upload.single('file'),
    batchUploadFeedbackController
  );

  return router;
}
