import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleGetSbtListByProject,
  handleGetSbtTokenDetail,
  handleUpdateSbtStatus
} from '../controllers/sbtMetadataController';
import {
  createSbtMetadataValidatorMiddleware,
  sbtMetadataQuerySchema,
  sbtProjectIdParamSchema,
  sbtTokenIdParamSchema,
  updateSbtStatusBodySchema
} from '../validators/sbtMetadataValidator';

/** Tạo sub-router cho 3 API metadata SBT, giữ middleware riêng với các route mint admin cũ. */
export function createSbtMetadataRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const adminRoleMiddleware = createFreshRoleAuthorizationMiddleware(['admin']);
  const readRateLimiter = createRateLimitMiddleware(100, 60 * 1000, {
    bucketName: 'sbt-metadata-read'
  });
  const writeRateLimiter = createRateLimitMiddleware(20, 60 * 1000, {
    bucketName: 'sbt-metadata-write'
  });

  // Dữ liệu SBT đã public on-chain và có thể đọc qua RPC/explorer; GET public giúp gallery không cần auth.
  router.get(
    '/project/:projectId',
    readRateLimiter,
    createSbtMetadataValidatorMiddleware(sbtProjectIdParamSchema, 'params'),
    createSbtMetadataValidatorMiddleware(sbtMetadataQuerySchema, 'query'),
    handleGetSbtListByProject
  );

  router.get(
    '/token/:tokenId',
    readRateLimiter,
    createSbtMetadataValidatorMiddleware(sbtTokenIdParamSchema, 'params'),
    handleGetSbtTokenDetail
  );

  router.post(
    '/update-status',
    authenticationMiddleware,
    adminRoleMiddleware,
    writeRateLimiter,
    createSbtMetadataValidatorMiddleware(updateSbtStatusBodySchema, 'body'),
    handleUpdateSbtStatus
  );

  return router;
}
