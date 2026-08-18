import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { handleSbtTrigger } from '../controllers/sbtTriggerController';

/**
 * Hàm khởi tạo route SBT trigger cho Oracle.
 * Mục đích: cung cấp endpoint để Oracle service trigger mint SBT sau khi verify.
 *
 * Route này được mount tại /api/oracle trong app.ts,
 * nên full path là /api/oracle/sbt-trigger.
 *
 * Auth: JWT + role "oracle" bắt buộc.
 * Rate limit: 30 req/min để chống spam từ Oracle service.
 */
export function createSbtTriggerRoutes(): Router {
  const router = Router();

  const authMiddleware = createAuthenticationMiddleware();
  const oracleMiddleware = createFreshRoleAuthorizationMiddleware(['oracle']);
  const rateLimitMiddleware = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'oracle:sbt-trigger' });

  // POST /api/oracle/sbt-trigger
  // Trigger mint SBT sau khi Oracle verify thành công
  router.post(
    '/sbt-trigger',
    authMiddleware,
    oracleMiddleware,
    rateLimitMiddleware,
    handleSbtTrigger
  );

  return router;
}
