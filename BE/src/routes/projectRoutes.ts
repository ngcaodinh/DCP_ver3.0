import { Router } from 'express';
import {
  handleCreateProject,
  handleGetCreateProjectEligibility,
  handleGetOrganizationProjects,
  handleGetPendingApprovalProjects,
  handleGetPublicSupportProjectDetail,
  handleGetPublicSupportProjects,
  handleReviewProject,
  handleSubmitProject,
  handleUpdateProject,
  handleUploadProjectEvidences
} from '../controllers/projectController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/** Hàm khởi tạo route cho module project. Mục đích: gom API create, submit và review dự án. */
export function createProjectRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const getProjectsRateLimit = createRateLimitMiddleware(60, 60 * 1000, { bucketName: 'projects:get-list' });
  const createProjectRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'projects:create' });
  const createEligibilityRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'projects:create-eligibility' });
  const uploadEvidencesRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'projects:upload-evidences' });
  const submitProjectRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'projects:submit' });
  const updateProjectRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'projects:update' });
  const reviewProjectRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'projects:review' });
  const organizationAuthorizationMiddleware = createRoleAuthorizationMiddleware(['organizations']);
  const reviewerAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin', 'regulatory']);


  router.get('/public-support/:projectId', attachRequestMetadata(), getProjectsRateLimit, handleGetPublicSupportProjectDetail);
  router.get('/public-support', attachRequestMetadata(), getProjectsRateLimit, handleGetPublicSupportProjects);
  router.get(
    '/',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    getProjectsRateLimit,
    handleGetOrganizationProjects
  );

  router.post(
    '/',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    createProjectRateLimit,
    handleCreateProject
  );

  router.get(
    '/create-eligibility',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    createEligibilityRateLimit,
    handleGetCreateProjectEligibility
  );

  router.post(
    '/evidences/upload',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    uploadEvidencesRateLimit,
    handleUploadProjectEvidences
  );

  router.get(
    '/pending-approval',
    attachRequestMetadata(),
    authenticationMiddleware,
    reviewerAuthorizationMiddleware,
    reviewProjectRateLimit,
    handleGetPendingApprovalProjects
  );

  router.post(
    '/submit',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    submitProjectRateLimit,
    handleSubmitProject
  );

  router.patch(
    '/',
    attachRequestMetadata(),
    authenticationMiddleware,
    organizationAuthorizationMiddleware,
    updateProjectRateLimit,
    handleUpdateProject
  );

  router.post(
    '/review',
    attachRequestMetadata(),
    authenticationMiddleware,
    reviewerAuthorizationMiddleware,
    reviewProjectRateLimit,
    handleReviewProject
  );

  return router;
}

