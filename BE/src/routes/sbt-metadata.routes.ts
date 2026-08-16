import { Router, type NextFunction, type Request, type Response } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleGetSbtGallery,
  handleGetSbtListByProject,
  handleGetSbtTokenDetail,
  handleUpdateSbtStatus
} from '../controllers/sbtMetadataController';
import {
  createSbtMetadataValidatorMiddleware,
  sbtGalleryQuerySchema,
  sbtMetadataQuerySchema,
  sbtProjectIdParamSchema,
  sbtTokenIdParamSchema,
  updateSbtStatusBodySchema
} from '../validators/sbtMetadataValidator';

const SBT_METADATA_READ_WINDOW_MS = 60 * 1000;
const PUBLIC_SBT_METADATA_READ_MAX_REQUESTS = 100;
const SSR_SBT_METADATA_READ_MAX_REQUESTS = 600;
const INTERNAL_SSR_REQUEST_HEADER = 'X-DCP-SSR-Request';
const INTERNAL_SSR_REQUEST_HEADER_VALUE = '1';
const SSR_RATE_LIMIT_IDENTITY = 'server-rendered';

/** Tạo sub-router cho 3 API metadata SBT, giữ middleware riêng với các route mint admin cũ. */
export function createSbtMetadataRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const adminRoleMiddleware = createFreshRoleAuthorizationMiddleware(['admin']);
  const publicReadRateLimiter = createRateLimitMiddleware(PUBLIC_SBT_METADATA_READ_MAX_REQUESTS, SBT_METADATA_READ_WINDOW_MS, {
    bucketName: 'sbt-metadata-read'
  });
  const serverRenderedReadRateLimiter = createRateLimitMiddleware(
    SSR_SBT_METADATA_READ_MAX_REQUESTS,
    SBT_METADATA_READ_WINDOW_MS,
    {
      bucketName: 'sbt-metadata-read:ssr',
      clientIpResolver: () => SSR_RATE_LIMIT_IDENTITY
    }
  );
  /** Chọn quota riêng cho SSR nội bộ; Nginx loại header này khỏi mọi request public đi vào backend. */
  const readRateLimiter = (request: Request, response: Response, next: NextFunction): void => {
    const isServerRenderedRequest = request.get(INTERNAL_SSR_REQUEST_HEADER) === INTERNAL_SSR_REQUEST_HEADER_VALUE;
    const rateLimiter = isServerRenderedRequest ? serverRenderedReadRateLimiter : publicReadRateLimiter;
    rateLimiter(request, response, next);
  };
  const writeRateLimiter = createRateLimitMiddleware(20, 60 * 1000, {
    bucketName: 'sbt-metadata-write'
  });

  // Dữ liệu SBT đã public on-chain và có thể đọc qua RPC/explorer; GET public giúp gallery không cần auth.
  router.get(
    '/gallery',
    readRateLimiter,
    createSbtMetadataValidatorMiddleware(sbtGalleryQuerySchema, 'query'),
    handleGetSbtGallery
  );

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
