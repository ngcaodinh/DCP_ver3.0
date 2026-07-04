/**
 * Router cho public feedback API endpoints.
 * Không yêu cầu authentication, có rate limiting.
 */

import { Router } from 'express';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  getPublicFeedbackListController,
  getPublicFeedbackStatsController
} from '../controllers/publicFeedbackController';

/**
 * Rate limit: 30 requests mỗi phút cho mỗi IP.
 */
const PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG = {
  maxRequests: 30,
  windowMs: 60_000,
  bucketName: 'public-feedback'
};

/**
 * Tạo router cho public feedback routes.
 * @returns Express Router đã configured
 */
export function createPublicFeedbackRoutes(): Router {
  const router = Router();

  // Rate limiter cho public feedback endpoints
  const publicFeedbackRateLimiter = createRateLimitMiddleware(
    PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.maxRequests,
    PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.windowMs,
    { bucketName: PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.bucketName }
  );

  /**
   * GET /api/feedback/public/:projectId
   * Lấy danh sách feedback công khai với pagination.
   * Chỉ trả về feedback không bị flag.
   * Rate limit: 30 requests/phút/IP.
   */
  router.get(
    '/public/:projectId',
    publicFeedbackRateLimiter,
    getPublicFeedbackListController
  );

  /**
   * GET /api/feedback/stats/:projectId
   * Lấy thống kê feedback công khai cho một dự án.
   * Trả về avgRating, totalCount, distribution.
   * Rate limit: 30 requests/phút/IP.
   * Kết quả được cache trong 10 phút.
   */
  router.get(
    '/stats/:projectId',
    publicFeedbackRateLimiter,
    getPublicFeedbackStatsController
  );

  return router;
}
