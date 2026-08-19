import { Router } from 'express';
import { handleGetFoundationKycStatus, handleGetUnifiedTimeline } from '../controllers/transparencyController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/**
 * Hàm khởi tạo route cho module transparency.
 * Mục đích: cung cấp API unified timeline cho Transparency Dashboard (Lane D).
 *
 * Routes:
 * - GET /api/transparency/unified-timeline : unified timeline với cursor-based pagination
 *
 * LƯU Ý BẢO MẬT - QUYẾT ĐỊNH CÔNG KHAI CÓ CHỦ ĐÍCH:
 * ---------------------------------------------------------------------------
 * Endpoint này là PUBLIC và INTENTIONALLY unauthenticated vì:
 * 1. Transparency Dashboard (Lane D) được thiết kế cho mục đích kiểm toán pháp lý
 *    - Theo QA plan D1, dashboard này là công khai để thể hiện tính minh bạch
 * 2. Dữ liệu trả về (wallet addresses, PayOS order codes, amounts) KHÔNG phải PII
 *    - Blockchain transactions là PUBLIC by design - tất cả dữ liệu đều có thể xem
 *      trên blockchain explorer
 *    - PayOS order codes và amounts là transaction metadata không liên quan đến
 *      danh tính cá nhân
 * 3. Rate limiting đã được áp dụng (100 req/min) để ngăn chặn abuse
 * 4. KHÔNG có dữ liệu cá nhân nhạy cảm (email, tên, số điện thoại) được expose
 * ---------------------------------------------------------------------------
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

  const foundationKycStatusRateLimit = createRateLimitMiddleware(60, 60 * 1000, {
    bucketName: 'transparency:foundation-kyc'
  });

  router.get('/foundation-kyc-status', foundationKycStatusRateLimit, handleGetFoundationKycStatus);

  return router;
}
