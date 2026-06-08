import { Router } from 'express';
import {
  handleGetSybilUserList,
  handleGetSybilUserDetail,
  handleToggleSybilStatus,
  handleGetSybilSummaryMetrics
} from '../controllers/sybilController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/**
 * Hàm khởi tạo route cho module Sybil Management.
 * Mục đích: gom các tuyến API xử lý FR5/UC5.1 theo chuẩn MVC.
 *
 * Access control:
 * - Chỉ 'admin' và 'regulatory' role được phép truy cập toàn bộ endpoints.
 * - Rate limiting được áp dụng để ngăn abuse.
 *
 * OWASP compliance:
 * - A01: Broken Access Control — middleware kiểm tra role trước khi xử lý.
 * - A07: Security Logging & Monitoring Failures — mọi toggle action đều được ghi log.
 */
export function createSybilRoutes(): Router {
  const router = Router();

  const authenticationMiddleware = createAuthenticationMiddleware();
  const sybilAdminAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin', 'regulatory']);

  // Rate limiters cho từng endpoint
  const getUserListRateLimit = createRateLimitMiddleware(60, 60 * 1000, { bucketName: 'sybil:user-list' });
  const getUserDetailRateLimit = createRateLimitMiddleware(60, 60 * 1000, { bucketName: 'sybil:user-detail' });
  const toggleRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'sybil:toggle' });
  const getSummaryMetricsRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'sybil:summary-metrics' });

  // GET /api/sybil/users — lấy danh sách người dùng cho bảng quản lý (phân trang, lọc, tìm kiếm)
  router.get(
    '/users',
    attachRequestMetadata(),
    authenticationMiddleware,
    sybilAdminAuthorizationMiddleware,
    getUserListRateLimit,
    handleGetSybilUserList
  );

  // GET /api/sybil/users/:userId — lấy chi tiết một người dùng kèm donation history
  router.get(
    '/users/:userId',
    attachRequestMetadata(),
    authenticationMiddleware,
    sybilAdminAuthorizationMiddleware,
    getUserDetailRateLimit,
    handleGetSybilUserDetail
  );

  // POST /api/sybil/toggle — toggle trạng thái Sybil (mark/unmark), chỉ Admin/Regulatory Bodies
  router.post(
    '/toggle',
    attachRequestMetadata(),
    authenticationMiddleware,
    sybilAdminAuthorizationMiddleware,
    toggleRateLimit,
    handleToggleSybilStatus
  );

  // GET /api/sybil/summary-metrics — lấy metrics tổng hợp cho dashboard
  router.get(
    '/summary-metrics',
    attachRequestMetadata(),
    authenticationMiddleware,
    sybilAdminAuthorizationMiddleware,
    getSummaryMetricsRateLimit,
    handleGetSybilSummaryMetrics
  );

  return router;
}
