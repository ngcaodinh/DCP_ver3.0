import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleGetPendingManualReview,
  handleGetPendingManualReviewCounts,
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
  const adminRoleMiddleware = createFreshRoleAuthorizationMiddleware(['admin']);
  // Tách 2 bucket: read (refresh liên tục không ảnh hưởng) và action (approve/reject)
  const rateLimitRead = createRateLimitMiddleware(120, 60 * 1000, {
    bucketName: 'admin-manual-review-read'
  });
  const rateLimitAction = createRateLimitMiddleware(20, 60 * 1000, {
    bucketName: 'admin-manual-review-action'
  });

  // GET /api/disbursements/pending-review/counts — tổng hợp count cho dashboard.
  router.get(
    '/pending-review/counts',
    authMiddleware,
    adminRoleMiddleware,
    rateLimitRead,
    handleGetPendingManualReviewCounts
  );

  // GET  /api/disbursements/pending-review — danh sách chờ xử lý tay
  router.get(
    '/pending-review',
    authMiddleware,
    adminRoleMiddleware,
    rateLimitRead,
    handleGetPendingManualReview
  );

  // GET  /api/disbursements/:id/detail — chi tiết (kèm transfer logs + audit logs)
  // Đặt trước /:id/manual-approve và /:id/manual-reject để tránh routing conflict
  router.get(
    '/:id/detail',
    authMiddleware,
    adminRoleMiddleware,
    rateLimitRead,
    handleGetManualReviewDetail
  );

  // POST /api/disbursements/:id/manual-approve — retry PayOS transfer
  router.post(
    '/:id/manual-approve',
    authMiddleware,
    adminRoleMiddleware,
    rateLimitAction,
    handleManualApprove
  );

  // POST /api/disbursements/:id/manual-reject — reject với lý do
  router.post(
    '/:id/manual-reject',
    authMiddleware,
    adminRoleMiddleware,
    rateLimitAction,
    handleManualReject
  );

  return router;
}
