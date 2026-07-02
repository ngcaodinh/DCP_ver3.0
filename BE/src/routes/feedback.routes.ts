/**
 * Router cho feedback API endpoints.
 * Quản lý các tuyến liên quan đến beneficiary feedback.
 */

import { Router } from 'express';
import multer from 'multer';
import { batchUploadFeedbackController } from '../controllers/feedbackBatchController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { FEEDBACK_BATCH_RATE_LIMIT_CONFIG, MAX_BATCH_SIZE, MAX_UPLOAD_SIZE_BYTES } from '../controllers/feedbackBatchController';

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
