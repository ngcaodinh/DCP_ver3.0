import { getLogger } from '../config/logger';
import { findUserById } from '../models/authModel';
import { createUserNotification } from '../services/notificationService';
import { getSocketServer } from '../config/socketServer';
import {
  claimManualReviewEscalationCandidates,
  markManualReviewEscalationNotified,
  reconcileMissingManualReviewQueues,
  releaseManualReviewEscalation
} from '../services/manualReviewService';

const logger = getLogger();

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const ESCALATION_BATCH_LIMIT = 100;
const RECONCILIATION_MAX_ITEMS_PER_RUN = 500;

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Khởi động background worker kiểm tra queue manual review quá SLA.
 * Mục đích: dùng SLA snapshot trên manual_review_queue thay vì disbursement.updatedAt.
 */
export function startManualReviewEscalationWorker(): void {
  if (intervalId) return;

  void checkAndEscalate();

  intervalId = setInterval(() => {
    void checkAndEscalate();
  }, POLL_INTERVAL_MS);

  logger.info('Manual Review Escalation Worker đã khởi động.', {
    context: {
      pollIntervalMinutes: POLL_INTERVAL_MS / 60_000
    }
  });
}

/** Dừng worker khi graceful shutdown để tránh memory leak. */
export function stopManualReviewEscalationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Kiểm tra queue quá SLA và gửi escalation đúng một lần mỗi review cycle.
 */
/** Chạy một vòng escalation thủ công để test và job scheduler có thể tái sử dụng cùng logic. */
export async function runManualReviewEscalationOnce(): Promise<void> {
  await checkAndEscalate();
}

/** Kiểm tra queue quá SLA và gửi escalation đúng một lần mỗi review cycle. */
async function checkAndEscalate(): Promise<void> {
  try {
    await reconcileMissingManualReviewQueues({
      pageSize: ESCALATION_BATCH_LIMIT,
      maxItems: RECONCILIATION_MAX_ITEMS_PER_RUN
    });

    const superAdminUserId = process.env.SUPER_ADMIN_USER_ID?.trim();
    if (!superAdminUserId) {
      logger.error('Thiếu SUPER_ADMIN_USER_ID cho manual review escalation.');
      return;
    }

    const superAdminUser = await findUserById(superAdminUserId);
    if (!superAdminUser || superAdminUser.role !== 'admin' || superAdminUser.accountStatus !== 'ACTIVE') {
      logger.error('SUPER_ADMIN_USER_ID không trỏ tới admin ACTIVE hợp lệ.', {
        superAdminConfigured: Boolean(superAdminUserId)
      });
      return;
    }

    const now = new Date();
    const claimedItems = await claimManualReviewEscalationCandidates(now, ESCALATION_BATCH_LIMIT);
    if (claimedItems.length === 0) {
      return;
    }

    let escalatedCount = 0;
    for (const item of claimedItems) {
      try {
        const hoursOverdue = Math.max(0, Math.floor((now.getTime() - item.slaDeadline.getTime()) / 3_600_000));

        await createUserNotification({
          userId: superAdminUserId,
          notificationType: 'MANUAL_REVIEW_ESCALATION',
          title: `Manual review quá SLA: ${item.disbursementRequestId.slice(0, 12)}...`,
          content: `Disbursement ${item.disbursementRequestId} của project ${item.projectId} đã quá SLA manual review.`,
          deduplicationKey: `MANUAL_REVIEW_ESCALATION:${item.queueId}`,
          priority: 'CRITICAL',
          channels: ['IN_APP', 'EMAIL', 'PUSH'],
          metadata: {
            requestId: item.disbursementRequestId,
            queueId: item.queueId,
            reviewCycle: item.reviewCycle,
            projectId: item.projectId,
            organizationId: item.organizationId,
            assignedAdminId: item.assignedAdminId,
            slaDeadline: item.slaDeadline.toISOString(),
            hoursOverdue
          }
        });

        const marked = item.escalationClaimId
          ? await markManualReviewEscalationNotified(item.queueId, now, item.escalationClaimId)
          : await markManualReviewEscalationNotified(item.queueId, now);
        if (!marked) {
          continue;
        }
        escalatedCount += 1;

        getSocketServer()?.to('admin').emit('transfer:escalation-alert', {
          requestId: item.disbursementRequestId,
          queueId: item.queueId,
          reviewCycle: item.reviewCycle,
          hoursOverdue,
          timestamp: now.toISOString()
        });
      } catch (error) {
        if (item.escalationClaimId) {
          await releaseManualReviewEscalation(item.queueId, item.escalationClaimId);
        }
        logger.error('Gửi escalation notification thất bại, claim đã được giải phóng.', {
          queueId: item.queueId,
          errorMessage: String(error)
        });
      }
    }

    logger.warn('Manual Review Escalation: phát hiện queue quá hạn.', {
      context: { escalatedCount, claimedCount: claimedItems.length }
    });
  } catch (error) {
    logger.error('Manual Review Escalation Worker lỗi khi kiểm tra.', {
      errorMessage: String(error)
    });
  }
}
