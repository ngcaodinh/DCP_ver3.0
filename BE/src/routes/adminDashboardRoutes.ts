import { Router } from 'express';
import {
  handleGetAdminDashboardAuditLogs,
  handleGetAdminDashboardMetrics,
  handleGetAdminDashboardTimeline,
  handleGetAdminSystemErrorLogs,
  handleUpdateAdminSystemErrorLogReadState,
  handleGetAdminGuestSessionSummary,
  handleListAdminGuestSessions,
  handleInvalidateAdminGuestSession
} from '../controllers/adminDashboardController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/**
 * Hàm khởi tạo router cho dashboard admin.
 * Mục đích: gom các endpoint tổng quan hệ thống dùng dữ liệu thật cho trang `/admin`.
 */
export function createAdminDashboardRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const adminAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin']);
  const dashboardRateLimitMiddleware = createRateLimitMiddleware(60, 60 * 1000, {
    bucketName: 'admin:dashboard'
  });
  const adminActionRateLimitMiddleware = createRateLimitMiddleware(30, 60 * 1000, {
    // Bucket riêng cho admin action (invalidate) — tránh poll frontend consume hết quota dashboard
    bucketName: 'admin:action'
  });

  router.get(
    '/metrics',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleGetAdminDashboardMetrics
  );

  router.get(
    '/timeline',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleGetAdminDashboardTimeline
  );

  router.get(
    '/audit-logs',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleGetAdminDashboardAuditLogs
  );

  router.get(
    '/system-error-logs',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleGetAdminSystemErrorLogs
  );

  router.patch(
    '/system-error-logs/:logId/read',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleUpdateAdminSystemErrorLogReadState
  );

  router.get(
    '/guest-sessions/summary',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleGetAdminGuestSessionSummary
  );

  router.get(
    '/guest-sessions',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    dashboardRateLimitMiddleware,
    handleListAdminGuestSessions
  );

  router.post(
    '/guest-sessions/:sessionId/invalidate',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    adminActionRateLimitMiddleware,
    handleInvalidateAdminGuestSession
  );

  return router;
}
