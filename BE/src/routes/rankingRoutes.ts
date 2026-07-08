import { Router } from 'express';
import { handleGetCurrentRankingSnapshot, handleGetRankingV2, handleRecalculateRankingSnapshot } from '../controllers/rankingController';
import { handleGetTrustAdjustedRankings } from '../controllers/qfRankingController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/** Hàm khởi tạo route cho module ranking. Mục đích: gom API recalculate và API đọc bảng xếp hạng QF. */
export function createRankingRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const rankingAdminAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin', 'regulatory']);
  const recalculateRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'ranking:recalculate' });
  const getRankingRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'ranking:get' });
  const getRankingV2RateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'ranking:get:v2' });
  const trustAdjustedRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'ranking:trust-adjusted' });

  router.get('/', attachRequestMetadata(), getRankingRateLimit, handleGetCurrentRankingSnapshot);
  router.get('/v2', attachRequestMetadata(), getRankingV2RateLimit, handleGetRankingV2);
  router.get('/trust-adjusted', attachRequestMetadata(), trustAdjustedRateLimit, handleGetTrustAdjustedRankings);
  router.post(
    '/recalculate',
    attachRequestMetadata(),
    authenticationMiddleware,
    rankingAdminAuthorizationMiddleware,
    recalculateRateLimit,
    handleRecalculateRankingSnapshot
  );

  return router;
}
