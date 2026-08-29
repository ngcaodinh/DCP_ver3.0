import { Router } from 'express';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_VOTER_ROLES, AUDITOR_ROLE, ADMIN_ROLE } from '../constants/governanceRoles';
import { handleGetAuditorActiveProjects, handleGetAuditorFieldReport, handleGetAuditorPendingProjects, handleGetExecutiveActiveProjectDetail, handleGetExecutiveActiveProjects, handleGetExecutiveCaseDetail, handleGetExecutiveCases, handleGetMyAuditorFieldReports, handleGetMyAuditorListingRecords, handlePrepareArbitrationVoteSignature, handleRecoverProjectArbitrationOnChainDecision, handleRetryProjectActivation, handleSubmitAuditorFieldReport, handleSubmitAuditorListingVerification, handleSubmitProjectChallenge, handleUpdateMilestonePlan, handleVoteOnArbitration } from '../controllers/projectGovernanceController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { type AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { PROJECT_CHALLENGE_DAILY_LIMIT } from '../constants/projectListingPolicy';

/** Khởi tạo các route quản trị tách biệt để không làm phình project router cũ. */
export function createProjectGovernanceRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const executiveArbitrationSigningPayloadRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'executive-arbitration-signing-payload' });
  const executiveArbitrationVoteRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'executive-arbitration-vote' });
  const executiveArbitrationRecoveryRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'executive-arbitration-recovery' });
  router.put('/milestone-plan', authenticationMiddleware, createFreshRoleAuthorizationMiddleware(['organizations']), handleUpdateMilestonePlan);
  router.post('/challenges', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), createRateLimitMiddleware(PROJECT_CHALLENGE_DAILY_LIMIT, 24 * 60 * 60 * 1000, { bucketName: 'project-governance:challenge:daily-user', clientIpResolver: request => (request as AuthenticatedRequest).authenticatedUser?.userId || request.ip || 'unknown' }), createRateLimitMiddleware(5, 60 * 1000, { bucketName: 'project-governance:challenge' }), handleSubmitProjectChallenge);
  router.post('/auditor/field-report', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), createRateLimitMiddleware(10, 60 * 60 * 1000, { bucketName: 'auditor:field-report' }), handleSubmitAuditorFieldReport);
  router.get('/auditor/pending-projects', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), handleGetAuditorPendingProjects);
  router.get('/auditor/active-projects', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), handleGetAuditorActiveProjects);
  router.get('/auditor/field-reports', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), handleGetAuditorFieldReport);
  router.get('/auditor/my-field-reports', authenticationMiddleware, handleGetMyAuditorFieldReports);
  router.get('/auditor/my-listing-records', authenticationMiddleware, handleGetMyAuditorListingRecords);
  router.post('/auditor/listing-verification', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([AUDITOR_ROLE]), createRateLimitMiddleware(10, 60 * 60 * 1000, { bucketName: 'auditor:listing-verification' }), handleSubmitAuditorListingVerification);
  router.get('/executive/cases', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), handleGetExecutiveCases);
  router.get('/executive/cases/:arbitrationId', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), handleGetExecutiveCaseDetail);
  router.get('/executive/active-projects', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), handleGetExecutiveActiveProjects);
  router.get('/executive/active-projects/:projectId', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), handleGetExecutiveActiveProjectDetail);
  router.post('/executive/signing-payload', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), executiveArbitrationSigningPayloadRateLimit, handlePrepareArbitrationVoteSignature);
  router.post('/executive/vote', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), executiveArbitrationVoteRateLimit, handleVoteOnArbitration);
  router.post('/executive/retry-activation', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([EXECUTIVE_CHAIR_ROLE, 'admin']), handleRetryProjectActivation);
  router.post('/admin/executive/cases/:arbitrationId/recover-on-chain-decision', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE]), executiveArbitrationRecoveryRateLimit, handleRecoverProjectArbitrationOnChainDecision);
  return router;
}
