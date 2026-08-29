import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import {
  createRoleAuthorizationMiddleware
} from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleGetGeofence,
  handleUpsertGeofence
} from '../controllers/oracleController';
import { createSbtTriggerRoutes } from './sbt-trigger.routes';

/** Hàm khởi tạo route oracle — xác minh EXIF GPS + quản lý geofence. */
export function createOracleRoutes(): Router {
  const router = Router();

  const authMiddleware = createAuthenticationMiddleware();
  const orgMiddleware = createRoleAuthorizationMiddleware(['organizations']);
  const orgOrAdminMiddleware = createRoleAuthorizationMiddleware(['organizations', 'admin', 'regulatory']);

  // Chỉ còn geofence vì xác minh/ghi đè GPS đã ngừng sử dụng từ 2026-08-27.
  const geofenceReadRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'oracle:geofence-read' });
  const geofenceWriteRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'oracle:geofence-write' });

  // Geofence read — org + admin + regulatory đều có thể xem
  router.get(
    '/geofence/:projectId',
    authMiddleware,
    orgOrAdminMiddleware,
    geofenceReadRateLimit,
    handleGetGeofence
  );

  // Geofence write — chỉ tổ chức mới được vẽ polygon (B5)
  router.post(
    '/geofence/:projectId',
    authMiddleware,
    orgMiddleware,
    geofenceWriteRateLimit,
    handleUpsertGeofence
  );

  // SBT trigger — Oracle trigger mint SBT sau khi verify thành công (C3)
  // Route được mount trong createOracleRoutes nên full path là /api/oracle/sbt-trigger
  router.use(createSbtTriggerRoutes());

  return router;
}
