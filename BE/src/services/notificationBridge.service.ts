import { createUserNotification } from './notificationService';
import { webhookEvents, type DisbursementWebhookEventPayload } from '../events/webhookEvents';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Hàm khởi tạo notification bridge.
 * Đăng ký listeners để xử lý sự kiện webhook và enqueue notification qua queue (E1).
 *
 * Mục đích:
 * - Bridge webhook events (DISBURSEMENT_TRANSFERRED, ...) → notification queue.
 * - KHÔNG ghi thẳng DB ở đây — để worker xử lý async (throttle, channel routing, retry).
 * - Caller chỉ định channels + priority tùy nghiệp vụ.
 *   Bridge dùng default: IN_APP cho user, thêm EMAIL cho critical events.
 */
export function initializeNotificationBridge(): void {
  webhookEvents.on('DISBURSEMENT_TRANSFERRED', async (payload: DisbursementWebhookEventPayload) => {
    try {
      await createUserNotification({
        userId: payload.organizationId,
        notificationType: 'DISBURSEMENT_COMPLETED',
        title: 'Giải ngân thành công',
        content: `Yêu cầu giải ngân ${payload.requestId} đã được chuyển khoản thành công. Số tiền: ${payload.amount.toLocaleString('vi-VN')} VNĐ.`,
        deduplicationKey: `DISBURSEMENT_TRANSFERRED:${payload.requestId}`,
        channels: ['IN_APP', 'EMAIL'],
        priority: 'HIGH',
        enqueuedBy: 'bridge',
        metadata: {
          requestId: payload.requestId,
          projectId: payload.projectId,
          amount: payload.amount,
          status: payload.status,
          payosTransferStatus: payload.payosTransferStatus,
          payosTransferId: payload.payosTransferId,
          transactionHash: payload.transactionHash
        }
      });

      logger.info('Đã enqueue notification cho disbursement transfer thành công.', {
        requestId: payload.requestId,
        organizationId: payload.organizationId
      });
    } catch (error) {
      logger.error('Enqueue notification cho disbursement transfer thất bại.', {
        requestId: payload.requestId,
        errorMessage: (error as Error)?.message
      });
    }
  });

  webhookEvents.on('DISBURSEMENT_TRANSFER_FAILED', async (payload: DisbursementWebhookEventPayload) => {
    try {
      await createUserNotification({
        userId: payload.organizationId,
        notificationType: 'SYSTEM',
        title: 'Giải ngân thất bại',
        content: `Yêu cầu giải ngân ${payload.requestId} không thể hoàn tất. Vui lòng kiểm tra trạng thái và liên hệ hỗ trợ nếu cần.`,
        deduplicationKey: `DISBURSEMENT_TRANSFER_FAILED:${payload.requestId}`,
        channels: ['IN_APP', 'EMAIL'],
        priority: 'HIGH',
        enqueuedBy: 'bridge',
        metadata: {
          requestId: payload.requestId,
          projectId: payload.projectId,
          amount: payload.amount,
          status: payload.status,
          payosTransferStatus: payload.payosTransferStatus,
          payosTransferId: payload.payosTransferId
        }
      });

      logger.info('Đã enqueue notification cho disbursement transfer thất bại.', {
        requestId: payload.requestId,
        organizationId: payload.organizationId
      });
    } catch (error) {
      logger.error('Enqueue notification cho disbursement transfer failed thất bại.', {
        requestId: payload.requestId,
        errorMessage: (error as Error)?.message
      });
    }
  });

  logger.info('Notification bridge đã được khởi tạo (E1 async dispatch).');
}