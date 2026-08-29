import { Router } from 'express';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { createFreshRoleAuthorizationMiddleware, createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  handleDisbursementTransferWebhook,
  handleDisbursementTransferWebhookHealth,
  handleCreateDisbursementRequest,
  handleGetMyDisbursements,
  handleGetDisbursementDetail,
  handleGetDisbursementsByProject,
  handleGetMaxWithdrawable
} from '../controllers/disbursementController';
import { handleGetExecutivePendingDisbursements, handlePrepareDisbursementVoteSignature, handleRecoverDeadLetterDisbursementExecution, handleVoteOnDisbursement } from '../controllers/disbursementCommitteeController';
import { ADMIN_ROLE, EXECUTIVE_VOTER_ROLES } from '../constants/governanceRoles';

/**
 * Hàm khởi tạo router cho module disbursement.
 * Mục đích: tạo các endpoint API giải ngân multisig theo chuẩn MVC.
 */
export function createDisbursementRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const transferWebhookRateLimit = createRateLimitMiddleware(60, 60 * 1000, {
    bucketName: 'disbursement-transfer-webhook'
  });
  const executivePendingRateLimit = createRateLimitMiddleware(120, 60 * 1000, { bucketName: 'executive-disbursement-pending' });
  const executiveSigningPayloadRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'executive-disbursement-signing-payload' });
  const executiveVoteRateLimit = createRateLimitMiddleware(30, 60 * 1000, { bucketName: 'executive-disbursement-vote' });
  const executiveRecoveryRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'executive-disbursement-recovery' });

  /**
   * GET/POST /api/disbursement/webhook
   * Endpoint webhook FR8 cho callback transfer từ PayOS.
   * Quyen: cong khai (chi danh cho he thong PayOS callback).
   */
  router.get('/webhook', attachRequestMetadata(), transferWebhookRateLimit, handleDisbursementTransferWebhookHealth);
  router.post('/webhook', attachRequestMetadata(), transferWebhookRateLimit, handleDisbursementTransferWebhook);

  /**
   * POST /api/disbursement/create
   * Tao yeu cau rut tien (UC7.1).
   * Quyen: organizations (da KYC + Bank Account APPROVED).
   */
  router.post(
    '/create',
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['organizations']),
    handleCreateDisbursementRequest
  );

  /**
   * GET /api/disbursement/me
   * Lay danh sach yeu cau cua to chuc.
   * Quyen: organizations.
   */
  router.get(
    '/me',
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['organizations']),
    handleGetMyDisbursements
  );

  /** Các route vote phải đứng trước /:requestId để Express không hiểu executive là requestId. */
  router.get('/executive/pending', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), executivePendingRateLimit, handleGetExecutivePendingDisbursements);
  router.post('/executive/:requestId/signing-payload', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), executiveSigningPayloadRateLimit, handlePrepareDisbursementVoteSignature);
  router.post('/executive/:requestId/vote', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([...EXECUTIVE_VOTER_ROLES]), executiveVoteRateLimit, handleVoteOnDisbursement);
  router.post('/admin/executive/:requestId/recover-execution', authenticationMiddleware, createFreshRoleAuthorizationMiddleware([ADMIN_ROLE]), executiveRecoveryRateLimit, handleRecoverDeadLetterDisbursementExecution);

  /** GET số dư khả dụng phải đứng trước dynamic :requestId. */
  router.get(
    '/max-withdrawable/:projectId',
    authenticationMiddleware,
    createRoleAuthorizationMiddleware(['organizations']),
    handleGetMaxWithdrawable
  );

  /**
   * GET /api/disbursement/project/:projectId
   * Lay lich su giai ngan theo du an.
   * Quyen: cong khai (khong can dang nhap).
   */
  router.get(
    '/project/:projectId',
    handleGetDisbursementsByProject
  );
  /**
   * GET /api/disbursement/:requestId
   * Lay chi tiet yeu cau.
   * Quyen: organizations hoặc Ủy ban trong snapshot.
   */
  router.get(
    '/:requestId',
    authenticationMiddleware,
    createFreshRoleAuthorizationMiddleware(['organizations', ...EXECUTIVE_VOTER_ROLES]),
    handleGetDisbursementDetail
  );
  return router;
}
