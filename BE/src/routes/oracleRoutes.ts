import { Router } from 'express';
import multer from 'multer';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createUploadValidationMiddleware, createBatchUploadValidationMiddleware } from '../middleware/upload-validation.middleware';
import {
  handleVerifyImage,
  handleVerifyImageBatch,
  handleGetGeofence,
  handleUpsertGeofence,
  handleGetOverrideRequestById,
  handleGetPendingOverrides,
  handleVoteOverrideRequest
} from '../controllers/oracleController';
import { createSbtTriggerRoutes } from './sbt-trigger.routes';

/**
 * Multer memory storage: giữ file trong RAM để oracle service đọc EXIF buffer.
 * Không lưu disk vì ảnh chỉ cần để parse EXIF, không cần persist.
 * Giới hạn 10MB per file — fileSize thực sự được validate trong controller.
 */
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});

/** Hàm khởi tạo route oracle — xác minh EXIF GPS + quản lý geofence. */
export function createOracleRoutes(): Router {
  const router = Router();

  const authMiddleware = createAuthenticationMiddleware();
  const orgMiddleware = createRoleAuthorizationMiddleware(['organizations']);
  const adminMiddleware = createRoleAuthorizationMiddleware(['admin', 'regulatory']);
  const orgOrAdminMiddleware = createRoleAuthorizationMiddleware(['organizations', 'admin', 'regulatory']);

  // Rate limit tách riêng: verify (write) vs geofence read vs geofence write
  const verifyRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'oracle:verify' });
  const batchVerifyRateLimit = createRateLimitMiddleware(5, 60 * 1000, { bucketName: 'oracle:batch-verify' });
  const geofenceReadRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'oracle:geofence-read' });
  const geofenceWriteRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'oracle:geofence-write' });
  const overrideReadRateLimit = createRateLimitMiddleware(60, 60 * 1000, { bucketName: 'oracle:override-read' });
  // Vote rate limit thấp: mỗi commissioner chỉ vote 1 lần/request, rate limit để chống spam
  const voteRateLimit = createRateLimitMiddleware(20, 60 * 1000, { bucketName: 'oracle:override-vote' });

  // Xác minh ảnh minh chứng — tổ chức upload
  router.post(
    '/verify-image',
    authMiddleware,
    orgMiddleware,
    verifyRateLimit,
    memoryUpload.single('image'),
    createUploadValidationMiddleware('image'),
    handleVerifyImage
  );

  // Batch xác minh — tổ chức upload nhiều ảnh qua queue
  router.post(
    '/verify-image/batch',
    authMiddleware,
    orgMiddleware,
    batchVerifyRateLimit,
    memoryUpload.array('images', 10),
    createBatchUploadValidationMiddleware('image'),
    handleVerifyImageBatch
  );

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

  // Danh sách override request PENDING — admin + regulatory review (B4)
  router.get(
    '/pending-overrides',
    authMiddleware,
    adminMiddleware,
    overrideReadRateLimit,
    handleGetPendingOverrides
  );

  // [B2-fix #6] Chi tiết một override request — B4 OverrideVoteDrawer cần để render vote panel
  router.get(
    '/override-requests/:overrideRequestId',
    authMiddleware,
    adminMiddleware,
    overrideReadRateLimit,
    handleGetOverrideRequestById
  );

  // Vote override request — chỉ admin + regulatory trong commissionerSnapshot (B2)
  router.post(
    '/override-requests/:overrideRequestId/vote',
    authMiddleware,
    adminMiddleware,
    voteRateLimit,
    handleVoteOverrideRequest
  );

  // SBT trigger — Oracle trigger mint SBT sau khi verify thành công (C3)
  // Route được mount trong createOracleRoutes nên full path là /api/oracle/sbt-trigger
  router.use(createSbtTriggerRoutes());

  return router;
}
