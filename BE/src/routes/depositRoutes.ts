import { Router } from 'express';
import {
  handleCreateDeposit,
  handleDepositWebhook,
  handleDepositWebhookHealth,
  handleGetDepositSidebar,
  handleGetDepositStatus,
  handleGetTokenBalance,
} from '../controllers/depositController';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';

/**
 * Hàm khởi tạo route cho module deposit.
 * Mục đích: gom các API nạp tiền VNĐ và xử lý webhook PayOS.
 */
export function createDepositRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const depositRateLimit = createRateLimitMiddleware(20, 60 * 1000);

  router.post('/create', attachRequestMetadata(), authenticationMiddleware, depositRateLimit, handleCreateDeposit);
  router.get('/webhook', attachRequestMetadata(), depositRateLimit, handleDepositWebhookHealth);
  router.post('/webhook', attachRequestMetadata(), depositRateLimit, handleDepositWebhook);
  router.get('/sidebar', attachRequestMetadata(), authenticationMiddleware, depositRateLimit, handleGetDepositSidebar);
  router.get('/balance', attachRequestMetadata(), authenticationMiddleware, depositRateLimit, handleGetTokenBalance);
  router.get('/:orderCode', attachRequestMetadata(), authenticationMiddleware, depositRateLimit, handleGetDepositStatus);

  return router;
}

