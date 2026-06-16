import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import {
  handleGetSbtDlqList,
  handleRetrySbtMintJob,
  handleAdminMintSbt
} from '../controllers/sbtController';
import {
  createZodValidatorMiddleware,
  paginationQuerySchema,
  mintRequestIdParamSchema
} from '../validators/sbtValidator';

/**
 * Rate limiter cho admin retry endpoint.
 * Giới hạn 20 yêu cầu mỗi 15 phút để tránh abuse khi admin click re-run liên tục.
 */
const retryJobRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Quá nhiều yêu cầu retry. Vui lòng thử lại sau 15 phút.' }
});

/**
 * Hàm khởi tạo router cho module SBT mint.
 * Mục đích: cung cấp các endpoint API quản trị SBT mint (DLQ, retry, admin-mint).
 */
export function createSbtRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();

  /**
   * GET /api/sbt/dlq
   * Lấy danh sách DLQ entries cho admin UI.
   * Quyền: admin.
   */
  router.get(
    '/dlq',
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['admin']),
    createZodValidatorMiddleware(paginationQuerySchema, 'query'),
    handleGetSbtDlqList
  );

  /**
   * POST /api/sbt/retry-job/:mintRequestId
   * Admin trigger re-run job từ DLQ/FAILED.
   * Quyền: admin.
   */
  router.post(
    '/retry-job/:mintRequestId',
    retryJobRateLimiter,
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['admin']),
    createZodValidatorMiddleware(mintRequestIdParamSchema, 'params'),
    handleRetrySbtMintJob
  );

  /**
   * POST /api/sbt/admin-mint
   * Endpoint bị cấm — không cho mint tay theo Q4 decision.
   * Quyền: admin.
   * Response: 403 Forbidden.
   */
  router.post(
    '/admin-mint',
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['admin']),
    handleAdminMintSbt
  );

  return router;
}
