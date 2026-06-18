import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestId,
  updateDisbursementByRequestIdWithCondition,
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
  // Đọc trước để lấy giá trị cũ phục vụ rollback + audit log
  const previousDisbursement = await findDisbursementByRequestId(requestId);
  if (!previousDisbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }

  await removePendingJobsByRequestId(requestId);

  const newIdempotencyKey = `manual-approve-${requestId}-${Date.now()}`;

  // Atomic check-and-update: chỉ thành công nếu vẫn còn MANUAL_REVIEW.
  // Ngăn 2 admin approve cùng lúc gây double-transfer.
  const updated = await updateDisbursementByRequestIdWithCondition(
    requestId,
    { payosTransferStatus: 'MANUAL_REVIEW' },
    {
      payosTransferStatus: 'PROCESSING',
      payosTransferAttemptCount: 0,
      payosTransferLastError: null,
      transferIdempotencyKey: newIdempotencyKey
    }
  );
  if (!updated) {
    throw new ApplicationError(
      `Disbursement ${requestId} đã được xử lý bởi admin khác hoặc không còn ở trạng thái MANUAL_REVIEW.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  const { enqueued } = await enqueueDisbursementTransfer(requestId, 1, newIdempotencyKey);
  if (!enqueued) {
    // Rollback chỉ khi chính mình vừa set — tránh ghi đè nếu có thay đổi khác
    await updateDisbursementByRequestIdWithCondition(
      requestId,
      { payosTransferStatus: 'PROCESSING', transferIdempotencyKey: newIdempotencyKey },
      {
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferAttemptCount: previousDisbursement.payosTransferAttemptCount,
        payosTransferLastError: previousDisbursement.payosTransferLastError,
        transferIdempotencyKey: previousDisbursement.transferIdempotencyKey
      }
    );
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
      previousAttemptCount: previousDisbursement.payosTransferAttemptCount,
      previousError: previousDisbursement.payosTransferLastError
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

  // Atomic check-and-update: chỉ thành công nếu vẫn còn MANUAL_REVIEW.
  // Ngăn 2 admin reject cùng lúc gây duplicate audit log và duplicate notification.
  const updated = await updateDisbursementByRequestIdWithCondition(
    requestId,
    { payosTransferStatus: 'MANUAL_REVIEW' },
    {
      status: 'REJECTED',
      payosTransferStatus: 'FAILED',
      payosTransferLastError: `Admin reject: ${reason}`
    }
  );
  if (!updated) {
    const existing = await findDisbursementByRequestId(requestId);
    if (!existing) {
      throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
    }
    throw new ApplicationError(
      `Disbursement ${requestId} đã được xử lý bởi admin khác hoặc không còn ở trạng thái MANUAL_REVIEW.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  await createAdminAuditLog({
    auditId: randomUUID(),
    adminUserId,
    action: 'MANUAL_REJECT',
    targetRequestId: requestId,
    reason,
    metadata: {
      previousAttemptCount: updated.payosTransferAttemptCount,
      previousError: updated.payosTransferLastError
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
  const { organizationId } = updated;
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
