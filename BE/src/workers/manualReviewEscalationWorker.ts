import { getLogger } from '../config/logger';
import { findDisbursementsInManualReview } from '../models/disbursementModel';
import { createUserNotification } from '../services/notificationService';
import { getSocketServer } from '../config/socketServer';

const logger = getLogger();

/**
 * Ngưỡng thời gian trước khi escalate (ms).
 * EMERGENCY: 24h — cần xử lý gấp, liên quan khẩn cấp.
 * NORMAL: 72h — đủ thời gian cho admin xử lý trong ngày làm việc.
 */
const EMERGENCY_ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const NORMAL_ESCALATION_THRESHOLD_MS = 72 * 60 * 60 * 1000;

/**
 * Poll mỗi 30 phút để không bỏ sót case timeout xảy ra giữa 2 chu kỳ.
 * Không cần dày hơn vì notification dùng deduplicationKey — idempotent.
 */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Khởi động background worker kiểm tra và escalate các disbursement bị timeout ở MANUAL_REVIEW.
 * Pattern giống startRankingScheduler — setInterval + run ngay lần đầu.
 * Mục đích: đảm bảo admin/super-admin được nhắc nhở trước khi bỏ lỡ SLA.
 */
export function startManualReviewEscalationWorker(): void {
  if (intervalId) return; // Tránh double-start

  // Run ngay khi khởi động để phát hiện item tồn đọng từ trước khi restart
  void checkAndEscalate();

  intervalId = setInterval(() => {
    void checkAndEscalate();
  }, POLL_INTERVAL_MS);

  logger.info('Manual Review Escalation Worker đã khởi động.', {
    context: {
      emergencyThresholdHours: EMERGENCY_ESCALATION_THRESHOLD_MS / 3_600_000,
      normalThresholdHours: NORMAL_ESCALATION_THRESHOLD_MS / 3_600_000,
      pollIntervalMinutes: POLL_INTERVAL_MS / 60_000
    }
  });
}

/** Dừng worker khi graceful shutdown — tránh memory leak. */
export function stopManualReviewEscalationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Kiểm tra từng disbursement MANUAL_REVIEW:
 *   - EMERGENCY + quá 24h → escalate super-admin
 *   - NORMAL + quá 72h → escalate admin
 * Dùng deduplicationKey để mỗi disbursement chỉ escalate một lần (idempotent).
 */
async function checkAndEscalate(): Promise<void> {
  try {
    const items = await findDisbursementsInManualReview();
    if (items.length === 0) return;

    const now = Date.now();
    let escalatedCount = 0;

    for (const item of items) {
      const ageMs = now - new Date(item.updatedAt).getTime();
      const isEmergency = item.requestMode === 'EMERGENCY';
      const threshold = isEmergency ? EMERGENCY_ESCALATION_THRESHOLD_MS : NORMAL_ESCALATION_THRESHOLD_MS;

      if (ageMs < threshold) continue;

      const tierLabel = isEmergency ? 'EMERGENCY' : 'NORMAL';
      const hoursOverdue = Math.floor(ageMs / 3_600_000);

      // deduplicationKey chứa tier để escalate riêng từng mức nếu item leo thang qua 2 tier
      const deduplicationKey = `ESCALATION_${tierLabel}:${item.requestId}`;

      // Ưu tiên env var để dễ cấu hình theo môi trường; fallback 'admin' chỉ cho local dev
      const superAdminUserId = process.env.SUPER_ADMIN_USER_ID ?? 'admin';
      await createUserNotification({
        userId: superAdminUserId,
        notificationType: 'SYSTEM',
        title: isEmergency
          ? `🚨 KHẨN CẤP: Disbursement ${item.requestId.slice(0, 8)}... chờ xử lý hơn ${hoursOverdue}h`
          : `⚠️ Cảnh báo: Disbursement ${item.requestId.slice(0, 8)}... chờ xử lý hơn ${hoursOverdue}h`,
        content: `Disbursement requestId=${item.requestId}, amount=${new Intl.NumberFormat('vi-VN').format(item.amount)}₫, project=${item.projectId} đã ở trạng thái MANUAL_REVIEW trong ${hoursOverdue} giờ (tier ${tierLabel}). Admin cần xử lý ngay.`,
        deduplicationKey,
        metadata: {
          requestId: item.requestId,
          projectId: item.projectId,
          organizationId: item.organizationId,
          amount: item.amount,
          requestMode: item.requestMode,
          hoursOverdue,
          tier: tierLabel
        }
      });

      // Emit real-time alert lên admin room
      getSocketServer()?.to('admin').emit('transfer:escalation-alert', {
        requestId: item.requestId,
        requestMode: item.requestMode,
        hoursOverdue,
        tier: tierLabel,
        timestamp: new Date().toISOString()
      });

      escalatedCount++;
    }

    if (escalatedCount > 0) {
      logger.warn('Manual Review Escalation: phát hiện disbursement quá hạn.', {
        context: { escalatedCount, totalManualReview: items.length }
      });
    }
  } catch (err) {
    logger.error('Manual Review Escalation Worker lỗi khi kiểm tra.', {
      errorMessage: String(err)
    });
  }
}
