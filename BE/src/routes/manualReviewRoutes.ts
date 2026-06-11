import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleGetPendingManualReview,
  handleGetManualReviewDetail,
  handleManualApprove,
  handleManualReject
} from '../controllers/manualReviewController';

/**
 * Routes cho A3 Manual Review — mount tại /api/disbursements.
 * Tách riêng khỏi disbursementRoutes để không sửa code hiện tại.
 * Tất cả endpoints chỉ dành cho role admin.
 */
export function createManualReviewRoutes(): Router {
  const router = Router();
  const authMiddleware = createAuthenticationMiddleware();
  const adminRoleMiddleware = createRoleAuthorizationMiddleware(['admin']);
  const rateLimit = createRateLimitMiddleware(60, 60 * 1000, {
    bucketName: 'admin-manual-review'
  });

  // GET  /api/disbursements/pending-review — danh sách chờ xử lý tay
  router.get(
    '/pending-review',
    authMiddleware,
    adminRoleMiddleware,
    rateLimit,
    handleGetPendingManualReview
  );

  // GET  /api/disbursements/:id/detail — chi tiết (kèm transfer logs + audit logs)
  // Đặt trước /:id/manual-approve và /:id/manual-reject để tránh routing conflict
  router.get(
    '/:id/detail',
    authMiddleware,
    adminRoleMiddleware,
    rateLimit,
    handleGetManualReviewDetail
  );

  // POST /api/disbursements/:id/manual-approve — retry PayOS transfer
  router.post(
    '/:id/manual-approve',
    authMiddleware,
    adminRoleMiddleware,
    rateLimit,
    handleManualApprove
  );

  // POST /api/disbursements/:id/manual-reject — reject với lý do
  router.post(
    '/:id/manual-reject',
    authMiddleware,
    adminRoleMiddleware,
    rateLimit,
    handleManualReject
  );

  return router;
}
