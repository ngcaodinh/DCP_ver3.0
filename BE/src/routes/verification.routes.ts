/**
 * Route definitions cho module verification — xac minh giao dich va tong hop du an.
 * Muc dich: phuc vu Transparency Dashboard (Lane D) - D3.
 *
 * Routes:
 * - GET /api/transparency/verify/:correlationId — xac minh giao dich cu the
 * - GET /api/transparency/summary/:projectId — tong hop dong tien du an
 *
 * LUU Y BAO MAT - QUYET DINH CONG KHAI CO CHU DICHH:
 * ---------------------------------------------------------------------------
 * Cac endpoint nay la PUBLIC va INTENTIONALLY unauthenticated vi:
 * 1. Transparency Dashboard duoc thiet ke cho muc dich kiem toan phap ly
 *    — theo QA plan D1/D3, dashboard nay la cong khai de the hien tinh minh bach
 * 2. Du lieu tra ve (wallet addresses, PayOS order codes, amounts) KHONG phai PII
 *    - Blockchain transactions la PUBLIC by design
 *    - PayOS order codes va amounts la transaction metadata
 * 3. Rate limiting 100 req/phút — dùng CHUNG cho cả hai endpoint (một bucket), tính theo IP,
 *    mỗi instance đếm riêng bằng in-memory Map.
 * 4. Khong co du lieu ca nhan nhay cam (email, ten, so dien thoai) duoc expose
 * ---------------------------------------------------------------------------
 */
import { Router } from 'express';
import { handleVerifyTransaction, handleGetProjectSummary } from '../controllers/verificationController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/**
 * Tao router cho verification endpoints.
 * @returns Express Router da cau hinh
 */
export function createVerificationRoutes(): Router {
  const router = Router();

  // QĐ-8: dùng chung một bucket là chủ đích; tách bucket sẽ làm quota thực tế tăng gấp đôi.
  // Rate limit: 100 requests per minute cho cả hai verification endpoints.
  const verificationRateLimit = createRateLimitMiddleware(100, 60 * 1000, {
    bucketName: 'transparency:verification'
  });

  // GET /verify/:correlationId — xac minh giao dich cu the
  router.get(
    '/verify/:correlationId',
    verificationRateLimit,
    handleVerifyTransaction
  );

  // GET /summary/:projectId — tong hop dong tien du an
  router.get(
    '/summary/:projectId',
    verificationRateLimit,
    handleGetProjectSummary
  );

  return router;
}
