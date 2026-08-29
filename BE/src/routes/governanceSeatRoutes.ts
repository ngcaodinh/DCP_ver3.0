import { Router } from 'express';
import { ADMIN_ROLE, EXECUTIVE_VOTER_ROLES } from '../constants/governanceRoles';
import {
  handleCreateGovernanceSeat,
  handleConfirmGovernanceBootstrap,
  handleGetGovernanceSeats,
  handleGetGovernanceBootstrapState,
  handleSuspendGovernanceSeat
} from '../controllers/governanceSeatController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { handleGetPublicCommitteeDecisions, handleGetPublicCommitteeGovernanceEvents } from '../controllers/publicCommitteeGovernanceController';

/** Tạo route ghế Ủy ban, tách khỏi project governance để ranh giới quyền admin rõ ràng. */
export function createGovernanceSeatRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const publicGovernanceRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'public-committee-governance' });
  router.get('/public/events', publicGovernanceRateLimit, handleGetPublicCommitteeGovernanceEvents);
  router.get('/public/decisions', publicGovernanceRateLimit, handleGetPublicCommitteeDecisions);
  router.get('/seats', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE, ...EXECUTIVE_VOTER_ROLES]), handleGetGovernanceSeats);
  router.get('/seats/bootstrap/state', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE, ...EXECUTIVE_VOTER_ROLES]), handleGetGovernanceBootstrapState);
  router.post('/seats/bootstrap/confirm', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE]), handleConfirmGovernanceBootstrap);
  router.post('/seats', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE]), handleCreateGovernanceSeat);
  router.delete('/seats/:walletAddress', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE]), handleSuspendGovernanceSeat);
  return router;
}
