import { Router } from 'express';
import {
  handleGetTrustScore,
  handleGetTrustScoreDetail,
  handleRecalculateTrustScore
} from '../controllers/trustScoreController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/**
 * Hàm khởi tạo router cho module Trust Score.
 * Mục đích: gom các endpoint đọc / chi tiết / recalc trust score theo donorAddress,
 * phân quyền rõ ràng giữa public, authenticated và admin-only.
 */
export function createTrustScoreRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const adminAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin']);

  const getTrustScoreRateLimit = createRateLimitMiddleware(120, 60 * 1000, {
    bucketName: 'trust-score:get'
  });
  const detailRateLimit = createRateLimitMiddleware(60, 60 * 1000, {
    bucketName: 'trust-score:detail'
  });
  const recalculateRateLimit = createRateLimitMiddleware(10, 60 * 1000, {
    bucketName: 'trust-score:recalculate'
  });

  router.get('/', attachRequestMetadata(), getTrustScoreRateLimit, (request, response) => {
    // Khi mount tại '/api/trust-score', GET '/' không có donorAddress → trả 400 thay vì 404 cho rõ ràng.
    sendValidationError(response, 'Thiếu tham số donorAddress.');
  });

  router.get(
    '/:donorAddress',
    attachRequestMetadata(),
    getTrustScoreRateLimit,
    handleGetTrustScore
  );

  router.get(
    '/:donorAddress/detail',
    attachRequestMetadata(),
    authenticationMiddleware,
    detailRateLimit,
    handleGetTrustScoreDetail
  );

  router.post(
    '/:donorAddress/recalculate',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    recalculateRateLimit,
    handleRecalculateTrustScore
  );

  return router;
}

/**
 * Hàm trả lỗi validation 400 trong router — tách ra để handler '/' ngắn gọn, đọc rõ intent.
 * Dùng inline import để tránh vòng phụ thuộc và giữ module-level import nhất quán với controller.
 */
function sendValidationError(response: import('express').Response, message: string): void {
  // Lazy require để không pollute top-level imports khi chỉ phục vụ route sentinel này.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendErrorResponse } = require('../utils/apiResponse') as typeof import('../utils/apiResponse');
  sendErrorResponse(response, 400, message, 'VALIDATION_ERROR');
}