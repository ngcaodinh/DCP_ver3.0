/**
 * Router cho feedback API endpoints.
 * Quản lý các tuyến liên quan đến beneficiary feedback.
 */

import { Router } from 'express';
import multer from 'multer';
import { batchUploadFeedbackController } from '../controllers/feedbackBatchController';
import {
  handleGetFlaggedFeedback,
  handleFlagFeedback,
  handleUnflagFeedback,
  FEEDBACK_FLAG_READ_RATE_LIMIT_CONFIG,
  FEEDBACK_FLAG_ACTION_RATE_LIMIT_CONFIG
} from '../controllers/feedbackFlaggingController';
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

  // Rate limiters cho admin flagging endpoints
  const flagReadRateLimiter = createRateLimitMiddleware(
    FEEDBACK_FLAG_READ_RATE_LIMIT_CONFIG.maxRequests,
    FEEDBACK_FLAG_READ_RATE_LIMIT_CONFIG.windowMs,
    { bucketName: FEEDBACK_FLAG_READ_RATE_LIMIT_CONFIG.bucketName }
  );

  const flagActionRateLimiter = createRateLimitMiddleware(
    FEEDBACK_FLAG_ACTION_RATE_LIMIT_CONFIG.maxRequests,
    FEEDBACK_FLAG_ACTION_RATE_LIMIT_CONFIG.windowMs,
    { bucketName: FEEDBACK_FLAG_ACTION_RATE_LIMIT_CONFIG.bucketName }
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

  /**
   * GET /api/feedback/flagged
   * Lấy danh sách feedback đã được flag với phân trang.
   * Yêu cầu: authentication + admin role.
   * 
   * Query params:
   *   - page: Số trang (default: 1)
   *   - limit: Số lượng mỗi trang (default: 20, max: 50)
   *   - projectId: Lọc theo project (optional)
   *   - minRiskScore: Lọc theo risk score tối thiểu (optional)
   * 
   * Response:
   *   {
   *     success: true,
   *     data: {
   *       items: [...],
   *       pagination: { page, limit, total, totalPages }
   *     }
   *   }
   */
  router.get(
    '/flagged',
    createAuthenticationMiddleware(),
    createRoleAuthorizationMiddleware(['ADMIN']),
    flagReadRateLimiter,
    handleGetFlaggedFeedback
  );

  /**
   * POST /api/feedback/:id/flag
   * Admin flag một feedback thủ công.
   * Yêu cầu: authentication + admin role.
   * 
   * Body:
   *   - reason: Lý do flag (5-500 ký tự, bắt buộc)
   * 
   * Response:
   *   {
   *     success: true,
   *     data: { feedbackId, isFlagged, flagReason, flaggedAt, flaggedBy }
   *   }
   */
  router.post(
    '/:id/flag',
    createAuthenticationMiddleware(),
    createRoleAuthorizationMiddleware(['ADMIN']),
    flagActionRateLimiter,
    handleFlagFeedback
  );

  /**
   * POST /api/feedback/:id/unflag
   * Admin unflag một feedback.
   * Yêu cầu: authentication + admin role.
   * 
   * Response:
   *   {
   *     success: true,
   *     data: { feedbackId, isFlagged }
   *   }
   */
  router.post(
    '/:id/unflag',
    createAuthenticationMiddleware(),
    createRoleAuthorizationMiddleware(['ADMIN']),
    flagActionRateLimiter,
    handleUnflagFeedback
  );

  return router;
}
