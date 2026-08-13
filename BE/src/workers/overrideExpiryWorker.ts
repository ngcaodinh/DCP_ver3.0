import { getLogger } from '../config/logger';
import {
  findPendingOverrideRequestsExpiredBefore,
  expireOverrideRequest
} from '../models/oracleOverrideRequestModel';
import { recordAdminAuditLog } from '../services/audit-log.service';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { createUserNotification } from '../services/notificationService';

const logger = getLogger();

/**
 * Override request hết hạn sau 7 ngày nếu không đủ commissioner vote.
 * Đồng bộ với timeout của MultisigDisbursement (7 ngày) để business logic nhất quán.
 */
const OVERRIDE_EXPIRY_DAYS = 7;
const OVERRIDE_EXPIRY_MS = OVERRIDE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** Chạy mỗi 1 giờ — đủ nhanh để detect timeout trong vòng 1h, không quá dày. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Khởi động worker kiểm tra và expire các override request PENDING quá hạn.
 * Pattern giống startManualReviewEscalationWorker — setInterval + run ngay lần đầu.
 *
 * [B2-fix #7] Tạo worker này vì field expiredAt đã có trong schema nhưng không có gì set giá trị.
 * Nếu không có cron này, request PENDING sẽ treo vĩnh viễn khi commissioner không vote.
 */
export function startOverrideExpiryWorker(): void {
  if (intervalId) return; // Tránh double-start

  // Run ngay khi khởi động để phát hiện request tồn đọng từ trước khi restart
  void checkAndExpireOverdueRequests();

  intervalId = setInterval(() => {
    void checkAndExpireOverdueRequests();
  }, POLL_INTERVAL_MS);

  logger.info('Override Expiry Worker đã khởi động.', {
    context: { pollIntervalMs: POLL_INTERVAL_MS, expiryDays: OVERRIDE_EXPIRY_DAYS }
  });
}

/** Dừng worker — gọi khi graceful shutdown. */
export function stopOverrideExpiryWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Override Expiry Worker đã dừng.');
  }
}

/**
 * Quét các override request PENDING đã tạo trước ngưỡng expiry → expire + notify + audit log.
 * Idempotent: expireOverrideRequest chỉ update khi status còn PENDING.
 */
async function checkAndExpireOverdueRequests(): Promise<void> {
  const expiryCutoff = new Date(Date.now() - OVERRIDE_EXPIRY_MS);

  let expiredCount = 0;
  let errorCount = 0;

  try {
    const overdueRequests = await findPendingOverrideRequestsExpiredBefore(expiryCutoff);
    if (overdueRequests.length === 0) return;

    logger.info('Override Expiry Worker: tìm thấy request quá hạn.', {
      context: { count: overdueRequests.length, expiryCutoff }
    });

    for (const overrideRequest of overdueRequests) {
      try {
        const expired = await runMongoTransaction(async (session) => {
          const updated = session
            ? await expireOverrideRequest(overrideRequest.overrideRequestId, new Date(), session)
            : await expireOverrideRequest(overrideRequest.overrideRequestId, new Date());
          if (!updated) return null;
          await recordAdminAuditLog({
            actionId: `override-expired:${overrideRequest.overrideRequestId}`,
            actorType: 'SYSTEM',
            adminId: null,
            adminRole: null,
            actionType: 'OVERRIDE_EXPIRED',
            targetId: overrideRequest.overrideRequestId,
            targetType: 'OVERRIDE_REQUEST',
            reason: 'Override request expired by timeout',
            context: {
              overrideRequestId: overrideRequest.overrideRequestId,
              projectId: overrideRequest.projectId,
              organizationId: overrideRequest.organizationId,
              commissionerSnapshotSize: overrideRequest.commissionerSnapshot.length,
              outcome: 'EXPIRED_TIMEOUT'
            },
            session
          });
          return updated;
        });
        if (!expired) continue; // Đã được expire bởi chu kỳ khác (race condition bình thường)

        expiredCount++;

        // Notify tất cả commissioner trong snapshot và tổ chức
        await notifyOverrideExpired(overrideRequest);
      } catch (err) {
        errorCount++;
        logger.error('Override Expiry Worker: lỗi khi expire một request.', {
          overrideRequestId: overrideRequest.overrideRequestId,
          errorMessage: (err as Error)?.message
        });
      }
    }

    logger.info('Override Expiry Worker: hoàn thành chu kỳ.', {
      context: { expiredCount, errorCount, total: overdueRequests.length }
    });
  } catch (err) {
    logger.error('Override Expiry Worker: lỗi khi query overdue requests.', {
      errorMessage: (err as Error)?.message
    });
  }
}

/**
 * Notify tất cả commissioner trong snapshot + tổ chức khi override request bị expire do timeout.
 * Dùng Promise.allSettled để failure của 1 user không block notification cho người khác.
 */
async function notifyOverrideExpired(
  overrideRequest: {
    overrideRequestId: string;
    projectId: string;
    organizationId: string;
    commissionerSnapshot: Array<{ userId: string; role: string }>;
  }
): Promise<void> {
  const commissionerNotifyPromises = overrideRequest.commissionerSnapshot.map(({ userId }) =>
    createUserNotification({
      userId,
      notificationType: 'SYSTEM',
      title: 'Yêu cầu ghi đè GPS đã hết hạn',
      content: `Yêu cầu ghi đè GPS cho dự án ${overrideRequest.projectId} đã hết hạn sau ${OVERRIDE_EXPIRY_DAYS} ngày không được vote đủ.`,
      metadata: {
        overrideRequestId: overrideRequest.overrideRequestId,
        projectId: overrideRequest.projectId
      },
      deduplicationKey: `override-timeout-${overrideRequest.overrideRequestId}-${userId}`
    }).catch((err: Error) => {
      logger.warn('Gửi notification hết hạn cho commissioner thất bại.', {
        overrideRequestId: overrideRequest.overrideRequestId,
        userId,
        errorMessage: err.message
      });
    })
  );

  const orgNotifyPromise = createUserNotification({
    userId: overrideRequest.organizationId,
    notificationType: 'SYSTEM',
    title: 'Yêu cầu ghi đè GPS đã hết hạn',
    content: `Yêu cầu ghi đè GPS cho dự án ${overrideRequest.projectId} đã hết hạn sau ${OVERRIDE_EXPIRY_DAYS} ngày. Vui lòng re-submit minh chứng để tạo yêu cầu mới.`,
    metadata: {
      overrideRequestId: overrideRequest.overrideRequestId,
      projectId: overrideRequest.projectId
    },
    deduplicationKey: `override-timeout-org-${overrideRequest.overrideRequestId}`
  }).catch((err: Error) => {
    logger.warn('Gửi notification hết hạn cho tổ chức thất bại.', {
      overrideRequestId: overrideRequest.overrideRequestId,
      errorMessage: err.message
    });
  });

  await Promise.allSettled([...commissionerNotifyPromises, orgNotifyPromise]);
}
