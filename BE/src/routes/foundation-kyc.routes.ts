import { Router } from 'express';
import { FOUNDATION_KYC_SUBMISSION_POLICY } from '../constants/foundationKycPolicy';
import { submitFoundationKycController } from '../controllers/foundationKycController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { getPublicFeedbackClientIp } from '../utils/publicFeedbackClientIdentity';

/** Tạo router cho cổng KYC FOUNDATION public, không gắn authentication middleware. */
export function createFoundationKycRoutes(): Router {
  const router = Router();
  const submitRateLimit = createRateLimitMiddleware(
    FOUNDATION_KYC_SUBMISSION_POLICY.minute.maxRequests,
    FOUNDATION_KYC_SUBMISSION_POLICY.minute.windowMs,
    {
      bucketName: 'foundation-kyc:submit',
      clientIpResolver: getPublicFeedbackClientIp
    }
  );

  router.post('/submit', submitRateLimit, submitFoundationKycController);
  return router;
}

