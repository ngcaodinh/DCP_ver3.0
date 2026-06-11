import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestId,
  findDisbursementsInManualReview,
  DisbursementRecord
} from '../models/disbursementModel';
import {
  findTransferLogsByRequestId
} from '../models/disbursementTransferModel';
import {
  createAdminAuditLog,
  findAuditLogsByRequestId,
  AdminAuditLogRecord
} from '../models/adminAuditLogModel';
import { createUserNotification } from './notificationService';
import {
  enqueueDisbursementTransfer,
  removePendingJobsByRequestId
} from '../queues/disbursementTransferQueue';
import { getSocketServer } from '../config/socketServer';

const logger = getLogger();

// ============ TYPES ============

export type PendingReviewItem = {
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  requestMode: string;
  emergencyReason: string | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  beneficiaryBankAccount: DisbursementRecord['beneficiaryBankAccount'];
  updatedAt: Date;
  createdAt: Date;
  /** Thời điểm ước tính retry tiếp theo (null vì đã hết retry, chờ manual) */
  nextRetryAt: null;
};

export type TransferDetailItem = PendingReviewItem & {
  transferLogs: Awaited<ReturnType<typeof findTransferLogsByRequestId>>;
  auditLogs: AdminAuditLogRecord[];
  status: string;
  payosTransferStatus: string | null;
};

// ============ SERVICE FUNCTIONS ============

/**
 * Lấy danh sách disbursement đang ở MANUAL_REVIEW — chờ admin xử lý tay.
 * Mục đích: endpoint GET /api/disbursements/pending-review (A3 spec).
 */
export async function getPendingManualReview(): Promise<PendingReviewItem[]> {
  const disbursements = await findDisbursementsInManualReview();
  return disbursements.map(formatToPendingReviewItem);
}

/**
 * Lấy chi tiết một disbursement MANUAL_REVIEW kèm transfer logs và audit logs.
 * Mục đích: endpoint detail page A4.
 */
export async function getManualReviewDetail(requestId: string): Promise<TransferDetailItem> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }
  if (disbursement.payosTransferStatus !== 'MANUAL_REVIEW') {
    throw new ApplicationError(
      `Disbursement ${requestId} không ở trạng thái MANUAL_REVIEW.`,
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }
  const [transferLogs, auditLogs] = await Promise.all([
    findTransferLogsByRequestId(requestId),
    findAuditLogsByRequestId(requestId)
  ]);
  return {
    ...formatToPendingReviewItem(disbursement),
    status: disbursement.status,
    payosTransferStatus: disbursement.payosTransferStatus,
    transferLogs,
    auditLogs
  };
}

/**
 * Admin approve thủ công — re-enqueue disbursement vào Bull queue để retry PayOS.
 * Mục đích: endpoint POST /api/disbursements/:id/manual-approve (A3 spec).
 * Reset attemptCount về 0 để worker bắt đầu lại từ đầu với idempotency key mới.
 */
export async function manualApprove(requestId: string, adminUserId: string): Promise<void> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }
  if (disbursement.payosTransferStatus !== 'MANUAL_REVIEW') {
    throw new ApplicationError(
      `Disbursement ${requestId} không ở trạng thái MANUAL_REVIEW (hiện tại: ${disbursement.payosTransferStatus ?? 'null'}).`,
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }

  // Dọn dẹp job cũ nếu còn
  await removePendingJobsByRequestId(requestId);

  // Idempotency key mới để tránh duplicate với lần transfer trước
  const newIdempotencyKey = `manual-approve-${requestId}-${Date.now()}`;

  // Reset trạng thái transfer để worker xử lý lại từ đầu
  await updateDisbursementByRequestId(requestId, {
    payosTransferStatus: 'PROCESSING',
    payosTransferAttemptCount: 0,
    payosTransferLastError: null,
    transferIdempotencyKey: newIdempotencyKey
  });

  const { enqueued } = await enqueueDisbursementTransfer(requestId, 1, newIdempotencyKey);
  if (!enqueued) {
    // Rollback trạng thái nếu không enqueue được
    await updateDisbursementByRequestId(requestId, {
      payosTransferStatus: 'MANUAL_REVIEW',
      payosTransferAttemptCount: disbursement.payosTransferAttemptCount,
      payosTransferLastError: disbursement.payosTransferLastError,
      transferIdempotencyKey: disbursement.transferIdempotencyKey
    });
    throw new ApplicationError(
      'Không thể đẩy job vào queue. Redis có thể không khả dụng.',
      503,
      'INTERNAL_ERROR'
    );
  }

  // Ghi audit log
  await createAdminAuditLog({
    auditId: randomUUID(),
    adminUserId,
    action: 'MANUAL_APPROVE',
    targetRequestId: requestId,
    reason: null,
    metadata: {
      newIdempotencyKey,
      previousAttemptCount: disbursement.payosTransferAttemptCount,
      previousError: disbursement.payosTransferLastError
    }
  });

  // Thông báo real-time cho admin room
  getSocketServer()?.to('admin').emit('transfer:updated', {
    requestId,
    payosTransferStatus: 'PROCESSING',
    updatedAt: new Date().toISOString()
  });

  logger.info('Admin manual approve disbursement thành công.', {
    requestId,
    authenticatedUserId: adminUserId,
    idempotencyKey: newIdempotencyKey
  });
}

/**
 * Admin reject thủ công — huỷ disbursement với lý do rõ ràng.
 * Mục đích: endpoint POST /api/disbursements/:id/manual-reject (A3 spec).
 * Output: status = 'REJECTED', payosTransferStatus = 'FAILED'.
 */
export async function manualReject(
  requestId: string,
  adminUserId: string,
  reason: string
): Promise<void> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }
  if (disbursement.payosTransferStatus !== 'MANUAL_REVIEW') {
    throw new ApplicationError(
      `Disbursement ${requestId} không ở trạng thái MANUAL_REVIEW.`,
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }

  await removePendingJobsByRequestId(requestId);

  // Spec output: status = REJECTED, payosTransferStatus = FAILED
  await updateDisbursementByRequestId(requestId, {
    status: 'REJECTED',
    payosTransferStatus: 'FAILED',
    payosTransferLastError: `Admin reject: ${reason}`
  });

  await createAdminAuditLog({
    auditId: randomUUID(),
    adminUserId,
    action: 'MANUAL_REJECT',
    targetRequestId: requestId,
    reason,
    metadata: {
      previousAttemptCount: disbursement.payosTransferAttemptCount,
      previousError: disbursement.payosTransferLastError
    }
  });

  // Thông báo real-time cho admin room
  getSocketServer()?.to('admin').emit('transfer:updated', {
    requestId,
    status: 'REJECTED',
    payosTransferStatus: 'FAILED',
    updatedAt: new Date().toISOString()
  });

  // Notify tổ chức (NGO) — họ cần biết disbursement bị từ chối để xử lý tiếp
  // Donor cá nhân không liên kết trực tiếp với disbursement (linked qua project), chỉ notify org
  const { organizationId } = disbursement;
  await createUserNotification({
    userId: organizationId,
    notificationType: 'SYSTEM',
    title: 'Yêu cầu giải ngân bị từ chối',
    content: `Yêu cầu giải ngân ${requestId} (${new Intl.NumberFormat('vi-VN').format(disbursement.amount)}₫) đã bị từ chối bởi admin. Lý do: ${reason}`,
    deduplicationKey: `MANUAL_REJECT_NOTIFY:${requestId}`,
    metadata: {
      requestId,
      amount: disbursement.amount,
      projectId: disbursement.projectId,
      reason,
      rejectedByAdminId: adminUserId
    }
  });

  logger.info('Admin manual reject disbursement thành công.', {
    requestId,
    authenticatedUserId: adminUserId,
    reason,
    organizationId
  });
}

// ============ PRIVATE HELPERS ============

function formatToPendingReviewItem(d: DisbursementRecord): PendingReviewItem {
  return {
    requestId: d.requestId,
    projectId: d.projectId,
    organizationId: d.organizationId,
    amount: d.amount,
    requestMode: d.requestMode,
    emergencyReason: d.emergencyReason,
    payosTransferAttemptCount: d.payosTransferAttemptCount,
    payosTransferLastError: d.payosTransferLastError,
    beneficiaryBankAccount: d.beneficiaryBankAccount,
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
    nextRetryAt: null  // Đã hết retry tự động, chờ manual action
  };
}
