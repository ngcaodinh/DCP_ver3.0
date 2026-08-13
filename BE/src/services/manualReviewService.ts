import { randomUUID } from 'crypto';
import type { ClientSession } from 'mongoose';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { ApplicationError } from '../utils/applicationError';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import {
  DisbursementRecord,
  findDisbursementByRequestId,
  findDisbursementsByRequestIds,
  findDisbursementsInManualReview,
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { findUsersByRole } from '../models/authModel';
import {
  findTransferLogsByRequestId,
  DisbursementTransferLogRecord
} from '../models/disbursementTransferModel';
import {
  findAuditLogsByRequestId,
  AdminAuditLogRecord,
  AdminAuditAction
} from '../models/adminAuditLogModel';
import { recordAdminAuditLog } from './audit-log.service';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { createAdminActionOutbox } from '../models/adminActionOutboxModel';
import {
  acquireManualReviewActionLease,
  countPendingManualReviewByAdminIds,
  countPendingManualReviewQueuesByTab,
  findLatestManualReviewQueueByRequestId,
  claimManualReviewEscalationCandidates as claimManualReviewQueueEscalationCandidates,
  findPendingManualReviewQueueByRequestId,
  findPendingManualReviewQueuesByProject,
  findPendingManualReviewQueuesPaginated,
  countPendingManualReviewQueuesMissingRequestMode,
  markManualReviewQueueEscalated,
  ManualReviewAssignmentMethod,
  ManualReviewQueueCounts,
  ManualReviewQueueRecord,
  releaseManualReviewActionLease,
  releaseManualReviewEscalationClaim,
  resolveManualReviewQueue,
  upsertManualReviewQueue
} from '../models/manualReviewQueueModel';
import type { DisbursementRequestMode } from '../models/disbursementModel';
import { createUserNotification } from './notificationService';
import { getSocketServer } from '../config/socketServer';
import { getPayosTransferStatusByReferenceId } from './payosService';

const logger = getLogger();

const DEFAULT_MANUAL_REVIEW_PAGE = 1;
const DEFAULT_MANUAL_REVIEW_LIMIT = 50;
export const MANUAL_REVIEW_MAX_PAGE_LIMIT = 50;
const MANUAL_REVIEW_ACTION_LEASE_MS = 5 * 60 * 1000;
const MANUAL_REVIEW_NORMAL_SLA_MS = 72 * 60 * 60 * 1000;
const MANUAL_REVIEW_EMERGENCY_SLA_MS = 24 * 60 * 60 * 1000;
const MANUAL_REVIEW_ESCALATION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MANUAL_REVIEW_ASSIGNMENT_CURSOR_KEY = 'manual_review_queue:assignment_cursor';
const MANUAL_REVIEW_RECONCILIATION_CURSOR_KEY = 'manual_review_queue:reconciliation_cursor';
const MANUAL_REVIEW_RECONCILIATION_CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MANUAL_REVIEW_RECONCILIATION_PAGE_SIZE = 100;
const DEFAULT_MANUAL_REVIEW_RECONCILIATION_MAX_ITEMS = 500;
const MANUAL_REVIEW_QUEUE_OPEN_MAX_ATTEMPTS = 5;
const MANUAL_REVIEW_REQUEST_MODE_WARNING_INTERVAL_MS = 60_000;
let lastRequestModeWarningAt = 0;

// ============ TYPES ============

export type ManualReviewOpenSource =
  | 'payos_worker'
  | 'payos_webhook_failed'
  | 'finalize_failed'
  | 'backfill'
  | 'reconciliation';

export type PendingReviewBankAccount = {
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName?: string;
};

export type PendingReviewItem = {
  queueId: string;
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  requestMode: DisbursementRequestMode;
  emergencyReason: string | null;
  payosTransferStatus: string | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  reviewCycle: number;
  assignedAdminId: string | null;
  assignmentMethod: ManualReviewAssignmentMethod;
  slaDeadline: Date;
  escalatedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  nextRetryAt: null;
};

export type PendingManualReviewPage = {
  items: PendingReviewItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type PendingManualReviewCounts = ManualReviewQueueCounts;

export type ManualReviewTransferLogItem = Pick<
  DisbursementTransferLogRecord,
  'transferLogId' | 'attemptNumber' | 'payosTransferId' | 'amount' | 'status'
    | 'startedAt' | 'completedAt' | 'durationMs'
> & {
  errorMessage: string | null;
};

export type ManualReviewAuditLogItem = Pick<
  AdminAuditLogRecord,
  'auditId' | 'adminUserId' | 'action' | 'reason' | 'createdAt'
>;

export type TransferDetailItem = PendingReviewItem & {
  beneficiaryBankAccount: PendingReviewBankAccount;
  transferLogs: ManualReviewTransferLogItem[];
  auditLogs: ManualReviewAuditLogItem[];
  status: string;
};

export type ManualReviewDetailOptions = {
  revealBankAccount?: boolean;
  adminUserId?: string;
  auditRequestContext?: AuditRequestContext;
};

export type ManualReviewActionResult = {
  requestId: string;
  queueId: string;
  reviewCycle: number;
  status: string;
  payosTransferStatus: string | null;
};

export type OpenManualReviewQueueInput = {
  disbursement: DisbursementRecord;
  reason: string;
  retryCount?: number;
  source: ManualReviewOpenSource;
};

export type ManualReviewBackfillResult = {
  scanned: number;
  opened: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
};

export type ManualReviewReconciliationOptions = {
  pageSize?: number;
  maxItems?: number;
};

type ManualReviewReconciliationCursor = {
  updatedAt: Date;
  requestId: string;
};

type AssignmentResult = {
  assignedAdminId: string | null;
  assignmentMethod: ManualReviewAssignmentMethod;
  assignedAt: Date | null;
};

type PayosManualActionSnapshot =
  | { status: 'NO_TRANSFER' }
  | { status: 'FAILED'; transferId: string | null }
  | { status: 'PROCESSING'; transferId: string | null }
  | { status: 'SUCCESS'; transferId: string | null };

// ============ SERVICE FUNCTIONS ============

/**
 * Mở hoặc cập nhật manual review queue theo cách idempotent cho mọi ingress A1/A2.
 * @param input Snapshot disbursement và lý do chuyển sang manual review.
 * @returns Queue item đã persist.
 */
export async function openManualReviewQueueForDisbursement(
  input: OpenManualReviewQueueInput
): Promise<ManualReviewQueueRecord> {
  const sanitizedReason = sanitizeReason(input.reason);

  for (let attempt = 0; attempt < MANUAL_REVIEW_QUEUE_OPEN_MAX_ATTEMPTS; attempt += 1) {
    const latestQueue = await findLatestManualReviewQueueByRequestId(input.disbursement.requestId);
    const isNewReviewCycle = latestQueue?.status !== 'PENDING';
    const reviewCycle = latestQueue?.status === 'PENDING'
      ? latestQueue.reviewCycle
      : (latestQueue?.reviewCycle ?? 0) + 1;
    const assignment = isNewReviewCycle
      ? await chooseManualReviewAssignee(input.disbursement.projectId)
      : {
        assignedAdminId: latestQueue?.assignedAdminId ?? null,
        assignmentMethod: latestQueue?.assignmentMethod ?? 'UNASSIGNED' as const,
        assignedAt: latestQueue?.assignedAt ?? null
      };
    const slaDeadline = buildSlaDeadline(input.disbursement.requestMode, new Date());

    const { queue, created } = await upsertManualReviewQueue({
      disbursementRequestId: input.disbursement.requestId,
      payosTransferId: input.disbursement.payosTransferId,
      projectId: input.disbursement.projectId,
      organizationId: input.disbursement.organizationId,
      reason: sanitizedReason,
      retryCount: input.retryCount ?? input.disbursement.payosTransferAttemptCount ?? 0,
      reviewCycle,
      requestMode: input.disbursement.requestMode,
      assignedAdminId: assignment.assignedAdminId,
      assignmentMethod: assignment.assignmentMethod,
      assignedAt: assignment.assignedAt,
      slaDeadline
    });

    if (queue.status !== 'PENDING') {
      // Queue vừa được resolve giữa lúc đọc latest và upsert; thử cycle kế tiếp có giới hạn.
      continue;
    }

    if (created && isNewReviewCycle) {
      await notifyAssignedReviewer(queue, input.disbursement, input.source);
      emitManualReviewRequired(queue, input.disbursement);
    }

    logger.warn('Manual review queue item đã được mở hoặc cập nhật.', {
      requestId: input.disbursement.requestId,
      queueId: queue.queueId,
      reviewCycle: queue.reviewCycle,
      source: input.source,
      assignedAdminId: queue.assignedAdminId ?? undefined
    });

    return queue;
  }

  throw new ApplicationError(
    `Không thể mở manual review queue cho ${input.disbursement.requestId} do state liên tục thay đổi.`,
    409,
    'INVALID_STATUS_TRANSITION'
  );
}

/** Cảnh báo bounded khi queue PENDING còn row thiếu snapshot requestMode sau migration. */
async function warnIfPendingManualReviewRequestModeBackfillIncomplete(): Promise<void> {
  const now = Date.now();
  if (lastRequestModeWarningAt > 0 && now - lastRequestModeWarningAt < MANUAL_REVIEW_REQUEST_MODE_WARNING_INTERVAL_MS) {
    return;
  }
  lastRequestModeWarningAt = now;

  try {
    const missingCount = await countPendingManualReviewQueuesMissingRequestMode();
    if (missingCount > 0) {
      logger.warn('Manual review queue còn PENDING thiếu snapshot requestMode; migration/backfill chưa hoàn tất.', {
        missingCount
      });
    }
  } catch (error) {
    logger.warn('Không thể kiểm tra queue PENDING thiếu snapshot requestMode.', {
      errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
  }
}

/**
 * Lấy danh sách manual review pending từ queue durable với phân trang và DTO không chứa bank PII thô.
 */
export async function getPendingManualReview(
  options?: Partial<{
    page: number;
    limit: number;
    overdueOnly: boolean;
    requestMode: DisbursementRequestMode;
  }>
): Promise<PendingManualReviewPage> {
  const page = normalizePage(options?.page);
  const limit = normalizeLimit(options?.limit);
  if (page === 1 && limit > 1 && !options?.overdueOnly && !options?.requestMode) {
    void warnIfPendingManualReviewRequestModeBackfillIncomplete();
  }
  const { items: queueItems, total } = await findPendingManualReviewQueuesPaginated({
    page,
    limit,
    overdueOnly: options?.overdueOnly,
    requestMode: options?.requestMode
  });

  const disbursements = await findDisbursementsByRequestIds(
    queueItems.map(queueItem => queueItem.disbursementRequestId)
  );
  const disbursementByRequestId = new Map(disbursements.map(disbursement => [disbursement.requestId, disbursement]));
  const items = queueItems
    .map((queueItem) => {
      const disbursement = disbursementByRequestId.get(queueItem.disbursementRequestId);
      return disbursement ? formatToPendingReviewItem(queueItem, disbursement) : null;
    })
    .filter((item): item is PendingReviewItem => item !== null);

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/** Lấy tổng queue cho dashboard bằng aggregate đã gom theo các tab trong một lần đọc. */
export async function getPendingManualReviewCounts(): Promise<PendingManualReviewCounts> {
  return countPendingManualReviewQueuesByTab();
}

/**
 * Lấy chi tiết một manual review theo requestId, mặc định mask bank data và chỉ reveal khi có audit thành công.
 */
export async function getManualReviewDetail(
  requestId: string,
  options: ManualReviewDetailOptions = {}
): Promise<TransferDetailItem> {
  const [queueItem, disbursement] = await Promise.all([
    findPendingManualReviewQueueByRequestId(requestId),
    findDisbursementByRequestId(requestId)
  ]);

  if (!disbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }
  if (!queueItem || disbursement.payosTransferStatus !== 'MANUAL_REVIEW') {
    throw new ApplicationError(
      `Disbursement ${requestId} không ở trạng thái MANUAL_REVIEW.`,
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }

  const [transferLogs, initialAuditLogs] = await Promise.all([
    findTransferLogsByRequestId(requestId),
    findAuditLogsByRequestId(requestId)
  ]);
  let auditLogs = initialAuditLogs;
  const shouldRevealBankAccount = Boolean(options.revealBankAccount && options.adminUserId);

  if (shouldRevealBankAccount) {
    await createManualReviewAuditLogRequired(
      queueItem,
      options.adminUserId as string,
      'MANUAL_BANK_ACCOUNT_VIEW',
      null,
      { accessMode: 'REVEAL_ON_DEMAND' },
      options.auditRequestContext
    );
    // Audit phải được ghi xong trước khi đọc lại để response phản ánh đầy đủ lần reveal hiện tại.
    auditLogs = await findAuditLogsByRequestId(requestId);
  }

  return {
    ...formatToPendingReviewItem(queueItem, disbursement),
    beneficiaryBankAccount: shouldRevealBankAccount
      ? disbursement.beneficiaryBankAccount
      : maskBankAccountForReview(disbursement.beneficiaryBankAccount),
    status: disbursement.status,
    transferLogs: formatTransferLogsForReview(transferLogs),
    auditLogs: formatAuditLogsForReview(auditLogs)
  };
}

/**
 * Admin approve thủ công sau khi provider được đối soát terminal-safe, rồi enqueue retry PayOS.
 */
export async function manualApprove(
  requestId: string,
  adminUserId: string,
  auditRequestContext?: AuditRequestContext
): Promise<ManualReviewActionResult> {
  const lockId = randomUUID();
  const now = new Date();
  let newIdempotencyKey: string | null = null;
  let queueResolved = false;
  const queueItem = await acquireManualReviewActionLease({
    disbursementRequestId: requestId,
    lockId,
    now,
    leaseExpiresAt: new Date(now.getTime() + MANUAL_REVIEW_ACTION_LEASE_MS)
  });

  if (!queueItem) {
    throw new ApplicationError(
      `Disbursement ${requestId} đã được xử lý bởi admin khác hoặc đang có action lease.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  try {
    const disbursement = await ensureManualReviewDisbursement(requestId);
    const providerSnapshot = await reconcileProviderBeforeManualAction(disbursement);
    ensureProviderAllowsManualDecision(providerSnapshot, requestId);

    newIdempotencyKey = `manual-approve-${requestId}-${queueItem.queueId}`;
    const outboxEventId = `manual-approve-transfer:${queueItem.queueId}`;
    const updated = await runMongoTransaction(async (session) => {
      const transactionUpdated = await updateDisbursementByRequestIdWithCondition(
        requestId,
        { payosTransferStatus: 'MANUAL_REVIEW' },
        {
          payosTransferStatus: 'PROCESSING',
          payosTransferAttemptCount: 0,
          payosTransferLastError: null,
          transferIdempotencyKey: newIdempotencyKey
        },
        session
      );

      if (!transactionUpdated) {
        throw new ApplicationError(
          `Disbursement ${requestId} không còn ở trạng thái MANUAL_REVIEW.`,
          409,
          'INVALID_STATUS_TRANSITION'
        );
      }
      // Audit, queue resolution và outbox phải commit cùng transaction để không có quyết định mồ côi.
      await createManualReviewAuditLogRequired(queueItem, adminUserId, 'MANUAL_APPROVE', null, {
        requestId: disbursement.requestId,
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amountVnd: disbursement.amount,
        previousAttemptCount: disbursement.payosTransferAttemptCount,
        previousError: sanitizeProviderError(disbursement.payosTransferLastError),
        providerStatus: providerSnapshot.status
      }, auditRequestContext, session);
      await resolveQueueAfterAction(queueItem, lockId, 'APPROVED', adminUserId, null, session);
      await createAdminActionOutbox({
        eventId: outboxEventId,
        eventType: 'MANUAL_APPROVE_TRANSFER',
        payload: { requestId, idempotencyKey: newIdempotencyKey }
      }, session);
      return transactionUpdated;
    });
    queueResolved = true;
    emitTransferUpdated(requestId, {
      payosTransferStatus: 'PROCESSING',
      queueId: queueItem.queueId
    });

    return {
      requestId,
      queueId: queueItem.queueId,
      reviewCycle: queueItem.reviewCycle,
      status: updated.status,
      payosTransferStatus: updated.payosTransferStatus
    };
  } catch (error) {
    if (!queueResolved) {
      await releaseManualReviewActionLease(queueItem.queueId, lockId);
    }
    throw error;
  }
}

/**
 * Admin reject thủ công sau khi provider không còn processing/success để tránh chốt sai tiền.
 */
export async function manualReject(
  requestId: string,
  adminUserId: string,
  reason: string,
  auditRequestContext?: AuditRequestContext
): Promise<ManualReviewActionResult> {
  const sanitizedReason = sanitizeReason(reason);
  if (sanitizedReason.length < 10) {
    throw new ApplicationError('reason phải có ít nhất 10 ký tự.', 400, 'VALIDATION_ERROR');
  }

  const lockId = randomUUID();
  const now = new Date();
  let queueResolved = false;
  const queueItem = await acquireManualReviewActionLease({
    disbursementRequestId: requestId,
    lockId,
    now,
    leaseExpiresAt: new Date(now.getTime() + MANUAL_REVIEW_ACTION_LEASE_MS)
  });

  if (!queueItem) {
    throw new ApplicationError(
      `Disbursement ${requestId} đã được xử lý bởi admin khác hoặc đang có action lease.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  try {
    const disbursement = await ensureManualReviewDisbursement(requestId);
    const providerSnapshot = await reconcileProviderBeforeManualAction(disbursement);
    ensureProviderAllowsManualDecision(providerSnapshot, requestId);

    const updated = await runMongoTransaction(async (session) => {
      const transactionUpdated = await updateDisbursementByRequestIdWithCondition(
        requestId,
        { payosTransferStatus: 'MANUAL_REVIEW' },
        {
          status: 'REJECTED',
          payosTransferStatus: 'FAILED',
          payosTransferLastError: `Admin reject: ${sanitizedReason}`
        },
        session
      );

      if (!transactionUpdated) {
        throw new ApplicationError(
          `Disbursement ${requestId} không còn ở trạng thái MANUAL_REVIEW.`,
          409,
          'INVALID_STATUS_TRANSITION'
        );
      }
      // Audit, queue resolution và outbox phải commit cùng transaction để không có action reject dở dang.
      await createManualReviewAuditLogRequired(queueItem, adminUserId, 'MANUAL_REJECT', sanitizedReason, {
        requestId: disbursement.requestId,
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amountVnd: disbursement.amount,
        previousAttemptCount: disbursement.payosTransferAttemptCount,
        previousError: sanitizeProviderError(disbursement.payosTransferLastError),
        providerStatus: providerSnapshot.status
      }, auditRequestContext, session);
      await resolveQueueAfterAction(queueItem, lockId, 'REJECTED', adminUserId, sanitizedReason, session);
      // Cleanup job cũ là side effect hậu commit; state FAILED vẫn chặn stale worker nếu cleanup retry chậm.
      await createAdminActionOutbox({
        eventId: `manual-reject-transfer:${queueItem.queueId}`,
        eventType: 'MANUAL_REJECT_TRANSFER',
        payload: { requestId }
      }, session);
      return transactionUpdated;
    });
    queueResolved = true;
    await notifyManualRejectRecipientsSafely(updated, adminUserId, sanitizedReason, queueItem);
    emitTransferUpdated(requestId, {
      status: 'REJECTED',
      payosTransferStatus: 'FAILED',
      queueId: queueItem.queueId
    });

    return {
      requestId,
      queueId: queueItem.queueId,
      reviewCycle: queueItem.reviewCycle,
      status: updated.status,
      payosTransferStatus: updated.payosTransferStatus
    };
  } catch (error) {
    if (!queueResolved) {
      await releaseManualReviewActionLease(queueItem.queueId, lockId);
    }
    throw error;
  }
}

/**
 * Khôi phục queue còn thiếu cho các disbursement đã ở MANUAL_REVIEW nhưng chưa có item durable.
 */
export async function reconcileMissingManualReviewQueues(
  options: number | ManualReviewReconciliationOptions = {}
): Promise<ManualReviewBackfillResult> {
  const requestedPageSize = typeof options === 'number' ? options : options.pageSize;
  const requestedMaxItems = typeof options === 'number' ? undefined : options.maxItems;
  const pageSize = normalizeReconciliationLimit(
    requestedPageSize,
    DEFAULT_MANUAL_REVIEW_RECONCILIATION_PAGE_SIZE
  );
  const maxItems = normalizeReconciliationLimit(
    requestedMaxItems,
    DEFAULT_MANUAL_REVIEW_RECONCILIATION_MAX_ITEMS
  );
  const result: ManualReviewBackfillResult = {
    scanned: 0,
    opened: 0,
    skipped: 0,
    failed: 0,
    hasMore: false
  };
  let cursor = await readManualReviewReconciliationCursor();

  while (result.scanned < maxItems) {
    const currentPageSize = Math.min(pageSize, maxItems - result.scanned);
    const manualReviewDisbursements = cursor
      ? await findDisbursementsInManualReview(currentPageSize, cursor)
      : await findDisbursementsInManualReview(currentPageSize);
    if (manualReviewDisbursements.length === 0) {
      await clearManualReviewReconciliationCursor();
      break;
    }

    for (const disbursement of manualReviewDisbursements) {
      if (result.scanned >= maxItems) {
        break;
      }

      result.scanned += 1;
      cursor = { updatedAt: disbursement.updatedAt, requestId: disbursement.requestId };

      try {
        const existingQueue = await findPendingManualReviewQueueByRequestId(disbursement.requestId);
        if (existingQueue) {
          result.skipped += 1;
          continue;
        }

        await openManualReviewQueueForDisbursement({
          disbursement,
          reason: disbursement.payosTransferLastError || 'Backfill manual review queue.',
          retryCount: disbursement.payosTransferAttemptCount,
          source: 'reconciliation'
        });
        result.opened += 1;
      } catch (error) {
        result.failed += 1;
        logger.error('Không thể reconcile manual review queue item.', {
          requestId: disbursement.requestId,
          errorMessage: (error as Error)?.message
        });
      }
    }

    if (cursor) {
      await persistManualReviewReconciliationCursor(cursor);
    }

    if (result.scanned >= maxItems) {
      result.hasMore = manualReviewDisbursements.length >= currentPageSize;
      break;
    }

    if (manualReviewDisbursements.length < currentPageSize) {
      await clearManualReviewReconciliationCursor();
      break;
    }
  }

  return result;
}

/**
 * Lấy và đánh dấu các queue quá SLA để worker có thể gửi escalation idempotent.
 */
export async function claimManualReviewEscalationCandidates(
  now: Date,
  limit: number
): Promise<ManualReviewQueueRecord[]> {
  return claimManualReviewQueueEscalationCandidates({
    now,
    limit,
    claimId: randomUUID(),
    claimExpiresAt: new Date(now.getTime() + MANUAL_REVIEW_ESCALATION_CLAIM_LEASE_MS)
  });
}

/**
 * Đánh dấu queue đã gửi escalation sau khi notification được tạo thành công để notification lỗi vẫn được retry.
 */
export async function markManualReviewEscalationNotified(
  queueId: string,
  escalatedAt: Date,
  claimId?: string
): Promise<ManualReviewQueueRecord | null> {
  return claimId
    ? markManualReviewQueueEscalated(queueId, escalatedAt, claimId)
    : markManualReviewQueueEscalated(queueId, escalatedAt);
}

/** Giải phóng claim escalation khi provider notification lỗi để item được retry an toàn. */
export async function releaseManualReviewEscalation(
  queueId: string,
  claimId: string
): Promise<void> {
  await releaseManualReviewEscalationClaim(queueId, claimId);
}

// ============ PRIVATE HELPERS ============

/** Chuẩn hóa page từ query string để pagination không nhận số âm hoặc NaN. */
function normalizePage(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MANUAL_REVIEW_PAGE;
  }
  return Math.max(1, Math.floor(value as number));
}

/** Chuẩn hóa limit và cap 50 theo guardrail list API. */
function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MANUAL_REVIEW_LIMIT;
  }
  return Math.max(1, Math.min(MANUAL_REVIEW_MAX_PAGE_LIMIT, Math.floor(value as number)));
}

/** Chuẩn hóa page size/max items của reconciliation để mỗi vòng worker luôn có bound. */
function normalizeReconciliationLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(5_000, Math.floor(value as number)));
}

/** Đọc cursor reconciliation từ Redis để các vòng worker tiếp tục từ vị trí trước đó. */
async function readManualReviewReconciliationCursor(): Promise<ManualReviewReconciliationCursor | undefined> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    return undefined;
  }

  try {
    const serializedCursor = await redisClient.get(MANUAL_REVIEW_RECONCILIATION_CURSOR_KEY);
    if (!serializedCursor) {
      return undefined;
    }

    const parsedCursor = JSON.parse(serializedCursor) as { updatedAt?: unknown; requestId?: unknown };
    const updatedAt = new Date(String(parsedCursor.updatedAt || ''));
    if (!parsedCursor.requestId || Number.isNaN(updatedAt.getTime())) {
      await redisClient.del(MANUAL_REVIEW_RECONCILIATION_CURSOR_KEY);
      return undefined;
    }

    return { updatedAt, requestId: String(parsedCursor.requestId) };
  } catch (error) {
    logger.warn('Không thể đọc cursor reconciliation manual review từ Redis.', {
      errorMessage: (error as Error)?.message
    });
    return undefined;
  }
}

/** Lưu cursor reconciliation có TTL để restart dài ngày không giữ trạng thái cũ vô hạn. */
async function persistManualReviewReconciliationCursor(
  cursor: ManualReviewReconciliationCursor
): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.set(
      MANUAL_REVIEW_RECONCILIATION_CURSOR_KEY,
      JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), requestId: cursor.requestId }),
      { EX: MANUAL_REVIEW_RECONCILIATION_CURSOR_TTL_SECONDS }
    );
  } catch (error) {
    logger.warn('Không thể lưu cursor reconciliation manual review vào Redis.', {
      errorMessage: (error as Error)?.message
    });
  }
}

/** Xóa cursor khi đã quét hết dataset để vòng kế tiếp bắt đầu từ đầu. */
async function clearManualReviewReconciliationCursor(): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.del(MANUAL_REVIEW_RECONCILIATION_CURSOR_KEY);
  } catch (error) {
    logger.warn('Không thể xóa cursor reconciliation manual review khỏi Redis.', {
      errorMessage: (error as Error)?.message
    });
  }
}

/** Làm sạch lý do nghiệp vụ trước khi lưu queue/audit để tránh payload quá dài. */
function sanitizeReason(reason: string): string {
  return String(reason || 'Manual review required.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000) || 'Manual review required.';
}

/** Tính SLA snapshot tại thời điểm mở queue để updatedAt của disbursement không reset deadline. */
function buildSlaDeadline(requestMode: DisbursementRecord['requestMode'], now: Date): Date {
  const slaMs = requestMode === 'EMERGENCY'
    ? MANUAL_REVIEW_EMERGENCY_SLA_MS
    : MANUAL_REVIEW_NORMAL_SLA_MS;
  return new Date(now.getTime() + slaMs);
}

/** Chọn các field cần thiết của transfer log và loại bỏ payload/provider PII khỏi detail API. */
function formatTransferLogsForReview(
  transferLogs: DisbursementTransferLogRecord[]
): ManualReviewTransferLogItem[] {
  return transferLogs.map((transferLog) => ({
    transferLogId: transferLog.transferLogId,
    attemptNumber: transferLog.attemptNumber,
    payosTransferId: transferLog.payosTransferId,
    amount: transferLog.amount,
    status: transferLog.status,
    errorMessage: sanitizeProviderError(transferLog.errorMessage),
    startedAt: transferLog.startedAt,
    completedAt: transferLog.completedAt,
    durationMs: transferLog.durationMs
  }));
}

/** Chỉ trả audit field cần cho màn hình manual review, không lộ metadata nội bộ. */
function formatAuditLogsForReview(
  auditLogs: AdminAuditLogRecord[]
): ManualReviewAuditLogItem[] {
  return auditLogs
    .filter((auditLog) => (
      auditLog.action === 'MANUAL_APPROVE'
      || auditLog.action === 'MANUAL_REJECT'
      || auditLog.action === 'MANUAL_BANK_ACCOUNT_VIEW'
    ))
    .map((auditLog) => ({
      auditId: auditLog.auditId,
      adminUserId: auditLog.adminUserId,
      action: auditLog.action,
      reason: auditLog.reason,
      createdAt: auditLog.createdAt
    }));
}

/** Chọn admin ACTIVE theo project affinity, sau đó round-robin Redis, cuối cùng least-loaded khi Redis lỗi. */
async function chooseManualReviewAssignee(projectId: string): Promise<AssignmentResult> {
  const activeAdmins = await findUsersByRole(['admin']);
  const sortedActiveAdminIds = activeAdmins
    .filter(adminUser => adminUser.accountStatus === 'ACTIVE')
    .map(adminUser => adminUser.id)
    .filter(Boolean)
    .sort((leftAdminId, rightAdminId) => leftAdminId.localeCompare(rightAdminId));

  if (sortedActiveAdminIds.length === 0) {
    return { assignedAdminId: null, assignmentMethod: 'UNASSIGNED', assignedAt: null };
  }

  const projectQueues = await findPendingManualReviewQueuesByProject(projectId, sortedActiveAdminIds);
  const affinityAdminId = projectQueues
    .map(queueItem => queueItem.assignedAdminId)
    .find((assignedAdminId): assignedAdminId is string => Boolean(assignedAdminId && sortedActiveAdminIds.includes(assignedAdminId)));

  if (affinityAdminId) {
    return { assignedAdminId: affinityAdminId, assignmentMethod: 'PROJECT_AFFINITY', assignedAt: new Date() };
  }

  const redis = getRedisClientIfReady();
  if (redis) {
    try {
      const cursor = await redis.incr(MANUAL_REVIEW_ASSIGNMENT_CURSOR_KEY);
      const assignedAdminId = sortedActiveAdminIds[(cursor - 1) % sortedActiveAdminIds.length];
      return { assignedAdminId, assignmentMethod: 'ROUND_ROBIN', assignedAt: new Date() };
    } catch {
      // Redis chỉ tối ưu fairness; khi lỗi fallback sang workload DB để không block queue-open.
    }
  }

  const workloadMap = await countPendingManualReviewByAdminIds(sortedActiveAdminIds);
  const assignedAdminId = [...sortedActiveAdminIds]
    .sort((leftAdminId, rightAdminId) => {
      const workloadDiff = (workloadMap.get(leftAdminId) ?? 0) - (workloadMap.get(rightAdminId) ?? 0);
      return workloadDiff !== 0 ? workloadDiff : leftAdminId.localeCompare(rightAdminId);
    })[0];

  return { assignedAdminId, assignmentMethod: 'LEAST_LOADED', assignedAt: new Date() };
}

/** Gửi notification cho reviewer được assign, không dùng fallback userId hard-coded. */
async function notifyAssignedReviewer(
  queueItem: ManualReviewQueueRecord,
  disbursement: DisbursementRecord,
  source: ManualReviewOpenSource
): Promise<void> {
  if (!queueItem.assignedAdminId) {
    return;
  }

  await createUserNotification({
    userId: queueItem.assignedAdminId,
    notificationType: 'SYSTEM',
    title: 'Yêu cầu giải ngân cần manual review',
    content: `Yêu cầu giải ngân ${disbursement.requestId} cần được kiểm tra thủ công.`,
    deduplicationKey: `DISBURSEMENT_MANUAL_REVIEW:${queueItem.queueId}`,
    metadata: {
      requestId: disbursement.requestId,
      queueId: queueItem.queueId,
      reviewCycle: queueItem.reviewCycle,
      projectId: disbursement.projectId,
      source
    }
  });
}

/** Emit event sau khi queue đã persist để realtime không đi trước dữ liệu durable. */
function emitManualReviewRequired(queueItem: ManualReviewQueueRecord, disbursement: DisbursementRecord): void {
  getSocketServer()?.to('admin').emit('transfer:manual-review-required', {
    requestId: disbursement.requestId,
    queueId: queueItem.queueId,
    projectId: disbursement.projectId,
    amount: disbursement.amount,
    // Queue lưu snapshot để filter/UI ổn định; disbursement vẫn là nguồn sự thật tài chính.
    requestMode: queueItem.requestMode ?? disbursement.requestMode,
    timestamp: new Date().toISOString()
  });
}

/** Emit trạng thái transfer đã đổi sau khi queue/disbursement/audit đã cập nhật xong. */
function emitTransferUpdated(
  requestId: string,
  payload: Record<string, unknown>
): void {
  getSocketServer()?.to('admin').emit('transfer:updated', {
    requestId,
    ...payload,
    updatedAt: new Date().toISOString()
  });
}

/** Chuyển queue + disbursement thành DTO list, không trả bank account thô ở endpoint danh sách. */
function formatToPendingReviewItem(
  queueItem: ManualReviewQueueRecord,
  disbursement: DisbursementRecord
): PendingReviewItem {
  return {
    queueId: queueItem.queueId,
    requestId: disbursement.requestId,
    projectId: disbursement.projectId,
    organizationId: disbursement.organizationId,
    amount: disbursement.amount,
    // Queue lưu snapshot để filter/UI ổn định; disbursement vẫn là nguồn sự thật tài chính.
    requestMode: queueItem.requestMode ?? disbursement.requestMode,
    emergencyReason: disbursement.emergencyReason,
    payosTransferStatus: disbursement.payosTransferStatus,
    payosTransferAttemptCount: disbursement.payosTransferAttemptCount,
    payosTransferLastError: sanitizeProviderError(disbursement.payosTransferLastError),
    reviewCycle: queueItem.reviewCycle,
    assignedAdminId: queueItem.assignedAdminId,
    assignmentMethod: queueItem.assignmentMethod,
    slaDeadline: queueItem.slaDeadline,
    escalatedAt: queueItem.escalatedAt,
    updatedAt: queueItem.updatedAt,
    createdAt: queueItem.createdAt,
    nextRetryAt: null
  };
}

/** Mask bank account trong detail để A4 vẫn render được nhưng không thấy PII thô. */
function maskBankAccountForReview(bankAccount: DisbursementRecord['beneficiaryBankAccount']): PendingReviewBankAccount {
  const accountNumber = bankAccount.bankAccountNumber || '';
  const accountHolderName = bankAccount.accountHolderName || '';

  return {
    bankName: bankAccount.bankName,
    bankAccountNumber: accountNumber.length <= 4 ? '****' : `${'*'.repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`,
    accountHolderName: accountHolderName.length <= 2 ? '**' : `${accountHolderName.slice(0, 2)}${'*'.repeat(accountHolderName.length - 2)}`,
    branchName: bankAccount.branchName
  };
}

/** Đảm bảo request còn đúng trạng thái manual review trước khi resolve queue. */
async function ensureManualReviewDisbursement(requestId: string): Promise<DisbursementRecord> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    throw new ApplicationError(`Disbursement ${requestId} không tìm thấy.`, 404, 'NOT_FOUND');
  }
  if (disbursement.payosTransferStatus !== 'MANUAL_REVIEW') {
    throw new ApplicationError(
      `Disbursement ${requestId} không ở trạng thái MANUAL_REVIEW.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }
  return disbursement;
}

/** Đối soát PayOS trước manual action để không tạo double-transfer khi trạng thái còn unknown/processing. */
async function reconcileProviderBeforeManualAction(
  disbursement: DisbursementRecord
): Promise<PayosManualActionSnapshot> {
  try {
    const snapshot = await getPayosTransferStatusByReferenceId(disbursement.requestId);
    if (!snapshot.found) {
      return { status: 'NO_TRANSFER' };
    }

    return {
      status: snapshot.transferStatus,
      transferId: snapshot.transferId
    };
  } catch (error) {
    logger.warn('Không thể đối soát PayOS trước manual action.', {
      requestId: disbursement.requestId,
      errorMessage: sanitizeProviderError((error as Error)?.message || null) || undefined
    });
    throw new ApplicationError(
      'Chưa thể xác minh trạng thái PayOS. Vui lòng thử lại sau khi reconciliation hoàn tất.',
      409,
      'CONFLICT'
    );
  }
}

/** Chỉ cho phép manual decision khi provider xác nhận FAILED hoặc không tìm thấy transfer. */
function ensureProviderAllowsManualDecision(
  providerSnapshot: PayosManualActionSnapshot,
  requestId: string
): void {
  if (providerSnapshot.status === 'PROCESSING') {
    throw new ApplicationError(
      `PayOS transfer của ${requestId} vẫn đang PROCESSING, chưa được manual action.`,
      409,
      'CONFLICT'
    );
  }

  if (providerSnapshot.status === 'SUCCESS') {
    throw new ApplicationError(
      `PayOS transfer của ${requestId} đã SUCCESS, chờ đồng bộ webhook/finalization.`,
      409,
      'CONFLICT'
    );
  }
}

/** Resolve queue và kiểm tra race nếu lease không còn thuộc action hiện tại. */
async function resolveQueueAfterAction(
  queueItem: ManualReviewQueueRecord,
  lockId: string,
  status: 'APPROVED' | 'REJECTED',
  adminUserId: string,
  reason: string | null,
  session?: ClientSession
): Promise<void> {
  const resolved = await resolveManualReviewQueue({
    queueId: queueItem.queueId,
    lockId,
    status,
    adminUserId,
    reason,
    resolvedAt: new Date(),
    ...(session ? { session } : {})
  });

  if (!resolved) {
    throw new ApplicationError('Queue item đã được xử lý bởi action khác.', 409, 'INVALID_STATUS_TRANSITION');
  }
}

/** Ghi audit log có queueId/reviewCycle để truy vết đầy đủ manual decision. */
async function createManualReviewAuditLog(
  queueItem: ManualReviewQueueRecord,
  adminUserId: string,
  action: AdminAuditAction,
  reason: string | null,
  metadata: Record<string, unknown>,
  auditRequestContext?: AuditRequestContext,
  session?: ClientSession
): Promise<void> {
  await recordAdminAuditLog({
    actionId: randomUUID(),
    actorType: 'ADMIN',
    adminId: adminUserId,
    adminRole: 'admin',
    actionType: action,
    targetId: queueItem.disbursementRequestId,
    targetType: 'DISBURSEMENT_REQUEST',
    reason,
    requestContext: auditRequestContext,
    context: {
      ...metadata,
      queueId: queueItem.queueId,
      reviewCycle: queueItem.reviewCycle
    },
    ...(session ? { session } : {})
  });
}

/**
 * Ghi audit bắt buộc cho PII và manual decision, chuyển lỗi thành trạng thái retry an toàn.
 * Mục đích: không reveal bank account hoặc resolve action khi chưa có audit durable.
 */
async function createManualReviewAuditLogRequired(
  queueItem: ManualReviewQueueRecord,
  adminUserId: string,
  action: AdminAuditAction,
  reason: string | null,
  metadata: Record<string, unknown>,
  auditRequestContext?: AuditRequestContext,
  session?: ClientSession
): Promise<void> {
  try {
    await createManualReviewAuditLog(queueItem, adminUserId, action, reason, metadata, auditRequestContext, session);
  } catch (error) {
    logger.error('Ghi audit log manual review thất bại; action sẽ không được hoàn tất.', {
      requestId: queueItem.disbursementRequestId,
      queueId: queueItem.queueId,
      action,
      errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    });
    throw new ApplicationError(
      'Không thể ghi nhận audit log. Vui lòng thử lại sau.',
      503,
      'INTERNAL_ERROR'
    );
  }
}

/** Notify organization khi reject; lỗi notification được log để không phá state tài chính đã resolve. */
async function notifyManualRejectRecipientsSafely(
  disbursement: DisbursementRecord,
  adminUserId: string,
  reason: string,
  queueItem: ManualReviewQueueRecord
): Promise<void> {
  const notificationTargets = await buildManualRejectNotificationTargets(disbursement);

  for (const target of notificationTargets) {
    try {
      await createUserNotification({
        userId: target.userId,
        notificationType: 'SYSTEM',
        title: 'Yêu cầu giải ngân bị từ chối',
        content: `Yêu cầu giải ngân ${disbursement.requestId} đã bị từ chối bởi admin. Lý do: ${reason}`,
        deduplicationKey: `MANUAL_REJECT_NOTIFY:${queueItem.queueId}:${target.userId}`,
        metadata: {
          requestId: disbursement.requestId,
          queueId: queueItem.queueId,
          reviewCycle: queueItem.reviewCycle,
          amount: disbursement.amount,
          projectId: disbursement.projectId,
          reason,
          rejectedByAdminId: adminUserId,
          recipientKind: target.kind
        }
      });
    } catch (error) {
      logger.error('Gửi notification manual reject thất bại sau khi action đã hoàn tất.', {
        requestId: disbursement.requestId,
        queueId: queueItem.queueId,
        recipientKind: target.kind,
        errorMessage: (error as Error)?.message
      });
    }
  }
}

/** Xây danh sách recipient theo policy A3: chỉ organization nhận thông báo manual reject. */
async function buildManualRejectNotificationTargets(
  disbursement: DisbursementRecord
): Promise<Array<{ userId: string; kind: 'ORGANIZATION' | 'DONOR' }>> {
  return [{ userId: disbursement.organizationId, kind: 'ORGANIZATION' as const }];
}
