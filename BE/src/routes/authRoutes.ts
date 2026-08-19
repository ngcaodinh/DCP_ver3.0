import { Router } from 'express';
import {
  handleGetCurrentUserProfile,
  handleGetFoundationOrganizationKycSubmissions,
  handleGetMyActiveSessions,
  handleGetMyOrganizationKycSubmissions,
  handleGetMyOrganizationProfile,
  handleGetPendingOrganizationKycSubmissions,
  handleGoogleLogin,
  handleLogoutAll,
  handleOrganizationKycSubmission,
  handleRefreshToken,
  handleReviewOrganizationKycSubmission,
  handleSubmitBeneficiaryBankAccount
} from '../controllers/authController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRefreshCsrfMiddleware } from '../middleware/csrfMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/**
 * Hàm khởi tạo route cho module auth.
 * Mục đích: gom các tuyến xác thực theo chuẩn MVC.
 */
export function createAuthRoutes(): Router {
  const router = Router();

  const refreshRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'auth:refresh' });
  const loginRateLimit = createRateLimitMiddleware(5, 60 * 1000, { bucketName: 'auth:google-login' });
  const organizationKycSubmissionRateLimit = createRateLimitMiddleware(5, 60 * 1000, { bucketName: 'auth:organization-kyc-submission' });
  const organizationKycGetMyRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'auth:organization-kyc-get-my' });
  const organizationKycPendingRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'auth:organization-kyc-pending' });
  const foundationKycHistoryRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'auth:foundation-kyc-history' });
  const beneficiaryBankAccountSubmitRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'auth:beneficiary-bank-account-submit' });
  const organizationKycReviewRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'auth:organization-kyc-review' });
  const authenticationMiddleware = createAuthenticationMiddleware();
  const regulatoryKycReviewAuthorizationMiddleware = createFreshRoleAuthorizationMiddleware(['regulatory']);

  router.post('/google-login', attachRequestMetadata(), loginRateLimit, handleGoogleLogin);
  router.post(
    '/refresh',
    attachRequestMetadata(),
    refreshRateLimit,
    createRefreshCsrfMiddleware(),
    handleRefreshToken
  );

  router.get('/me', attachRequestMetadata(), authenticationMiddleware, handleGetCurrentUserProfile);
  router.get('/organization/profile/me', attachRequestMetadata(), authenticationMiddleware, handleGetMyOrganizationProfile);
  router.get('/sessions/me', attachRequestMetadata(), authenticationMiddleware, handleGetMyActiveSessions);
  router.post('/logout-all', attachRequestMetadata(), authenticationMiddleware, handleLogoutAll);
  router.post(
    '/organization/kyc-submissions',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationKycSubmissionRateLimit,
    handleOrganizationKycSubmission
  );
  router.get(
    '/organization/kyc-submissions/pending',
    attachRequestMetadata(),
    authenticationMiddleware,
    regulatoryKycReviewAuthorizationMiddleware,
    organizationKycPendingRateLimit,
    handleGetPendingOrganizationKycSubmissions
  );
  router.get(
    '/organization/kyc-submissions/foundation',
    attachRequestMetadata(),
    authenticationMiddleware,
    regulatoryKycReviewAuthorizationMiddleware,
    foundationKycHistoryRateLimit,
    handleGetFoundationOrganizationKycSubmissions
  );
  router.get(
    '/organization/kyc-submissions/me',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationKycGetMyRateLimit,
    handleGetMyOrganizationKycSubmissions
  );
  router.post(
    '/organization/kyc-submissions/me/beneficiary-bank-account',
    attachRequestMetadata(),
    authenticationMiddleware,
    beneficiaryBankAccountSubmitRateLimit,
    handleSubmitBeneficiaryBankAccount
  );
  router.patch(
    '/organization/kyc-submissions/:submissionId/review',
    attachRequestMetadata(),
    authenticationMiddleware,
    regulatoryKycReviewAuthorizationMiddleware,
    organizationKycReviewRateLimit,
    handleReviewOrganizationKycSubmission
  );

  return router;
}
