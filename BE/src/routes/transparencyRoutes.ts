import { Router } from 'express';
import { handleGetUnifiedTimeline } from '../controllers/transparencyController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/**
 * Hàm khởi tạo route cho module transparency.
 * Mục đích: cung cấp API unified timeline cho Transparency Dashboard (Lane D).
 *
 * Routes:
 * - GET /api/transparency/unified-timeline : unified timeline với cursor-based pagination
 */
export function createTransparencyRoutes(): Router {
  const router = Router();

  const timelineRateLimit = createRateLimitMiddleware(100, 60 * 1000, {
    bucketName: 'transparency:unified-timeline'
  });

  router.get(
    '/unified-timeline',
    timelineRateLimit,
    handleGetUnifiedTimeline
  );

  return router;
}
