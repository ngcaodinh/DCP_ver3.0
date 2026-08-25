import { Router } from 'express';
import {
  handleExecuteAuditorStake,
  handleGetAuditorOnboardingStatus,
  handleRegisterAuditorIntent,
  handleResumeAuditorIntent,
  handleRequestAuditorUnstake,
  handleRetryAuditorPayoutBurn,
  handleUpdateAuditorPayoutAccount,
  handleWithdrawAuditorStake
} from '../controllers/auditorOnboardingController';
import { createAuthenticationMiddleware, type AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

export function createAuditorOnboardingRoutes(): Router {
  const router = Router();
  const authentication = createAuthenticationMiddleware();
  const freshAdminAuthorization = createFreshRoleAuthorizationMiddleware(['admin']);
  const userRateLimit = (bucketName: string, maximum: number, windowMs: number) => createRateLimitMiddleware(maximum, windowMs, {
    bucketName,
    clientIpResolver: request => (request as AuthenticatedRequest).authenticatedUser?.userId || request.ip || 'unknown'
  });

  router.post('/register', attachRequestMetadata(), createRateLimitMiddleware(5, 60 * 60 * 1_000, { bucketName: 'auditor-onboarding:register' }), handleRegisterAuditorIntent);
  router.post('/resume', attachRequestMetadata(), createRateLimitMiddleware(10, 60 * 60 * 1_000, { bucketName: 'auditor-onboarding:resume' }), handleResumeAuditorIntent);
  router.post('/stake', attachRequestMetadata(), authentication, userRateLimit('auditor-onboarding:stake', 10, 60 * 60 * 1_000), handleExecuteAuditorStake);
  router.post('/unstake', attachRequestMetadata(), authentication, userRateLimit('auditor-onboarding:unstake', 10, 60 * 60 * 1_000), handleRequestAuditorUnstake);
  router.post('/withdraw', attachRequestMetadata(), authentication, userRateLimit('auditor-onboarding:withdraw', 10, 60 * 60 * 1_000), handleWithdrawAuditorStake);
  router.post('/payouts/:payoutId/retry-burn', attachRequestMetadata(), authentication, freshAdminAuthorization, userRateLimit('auditor-onboarding:retry-burn', 10, 60 * 60 * 1_000), handleRetryAuditorPayoutBurn);
  router.patch('/payout-account', attachRequestMetadata(), authentication, userRateLimit('auditor-onboarding:payout-account', 10, 60 * 60 * 1_000), handleUpdateAuditorPayoutAccount);
  router.get('/status/:intentId', attachRequestMetadata(), authentication, userRateLimit('auditor-onboarding:status', 60, 60 * 1_000), handleGetAuditorOnboardingStatus);
  return router;
}
