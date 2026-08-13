import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { handleListAdminAuditLogs } from '../controllers/audit-log.controller';

/** Tạo route đọc audit canonical, độc lập với dashboard audit legacy. */
export function createAuditLogRoutes(): Router {
  const router = Router();
  router.get(
    '/',
    createAuthenticationMiddleware(),
    createFreshRoleAuthorizationMiddleware(['admin']),
    createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'admin:audit-logs-read' }),
    handleListAdminAuditLogs
  );
  return router;
}
