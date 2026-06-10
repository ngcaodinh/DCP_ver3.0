import { Router } from 'express';
import { attachRequestMetadata } from '../../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../../middleware/rateLimitMiddleware';
import { handlePayosWebhookHealth, handlePayosWebhook } from '../../controllers/payosWebhookController';

/**
 * Hàm khởi tạo router cho webhook PayOS.
 * Mục đích: tạo các endpoint API webhook theo chuẩn MVC.
 * Không có authentication vì đây là endpoint công khai cho PayOS callback.
 */
export function createPayosWebhookRoutes(): Router {
  const router = Router();

  // Rate limit cho webhook - 100 requests mỗi phút
  const webhookRateLimit = createRateLimitMiddleware(100, 60 * 1000, {
    bucketName: 'payos-webhook'
  });

  /**
   * GET /api/webhooks/payos
   * Health check endpoint cho PayOS webhook.
   * Actor: PayOS system health-check.
   */
  router.get('/', attachRequestMetadata(), webhookRateLimit, handlePayosWebhookHealth);

  /**
   * POST /api/webhooks/payos
   * Xử lý webhook transfer từ PayOS cho FR8.
   * Actor: PayOS callback.
   */
  router.post('/', attachRequestMetadata(), webhookRateLimit, handlePayosWebhook);

  return router;
}
