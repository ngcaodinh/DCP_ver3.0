import { createUserNotification } from './notificationService';
import { webhookEvents, type DisbursementWebhookEventPayload } from '../events/webhookEvents';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Hàm khởi tạo notification bridge.
 * Đăng ký listeners để xử lý sự kiện webhook và tạo notification.
 * Mục đích: làm cầu nối tạm thời giữa webhook handler và notification service.
 */
export function initializeNotificationBridge(): void {
  // Listener cho sự kiện disbursement chuyển thành công
  webhookEvents.on('DISBURSEMENT_TRANSFERRED', async (payload: DisbursementWebhookEventPayload) => {
    try {
      await createUserNotification({
        userId: payload.organizationId,
        notificationType: 'DISBURSEMENT_SIGNED',
        title: 'Giải ngân thành công',
        content: `Yêu cầu giải ngân ${payload.requestId} đã được chuyển khoản thành công. Số tiền: ${payload.amount.toLocaleString('vi-VN')} VNĐ.`,
        deduplicationKey: `DISBURSEMENT_TRANSFERRED:${payload.requestId}`,
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

      logger.info('Đã tạo notification cho disbursement transfer thành công.', {
        requestId: payload.requestId,
        organizationId: payload.organizationId
      });
    } catch (error) {
      logger.error('Tạo notification cho disbursement transfer thất bại.', {
        requestId: payload.requestId,
        errorMessage: (error as Error)?.message
      });
    }
  });

  // Listener cho sự kiện disbursement transfer thất bại
  webhookEvents.on('DISBURSEMENT_TRANSFER_FAILED', async (payload: DisbursementWebhookEventPayload) => {
    try {
      await createUserNotification({
        userId: payload.organizationId,
        notificationType: 'SYSTEM',
        title: 'Giải ngân thất bại',
        content: `Yêu cầu giải ngân ${payload.requestId} không thể hoàn tất. Vui lòng kiểm tra trạng thái và liên hệ hỗ trợ nếu cần.`,
        deduplicationKey: `DISBURSEMENT_TRANSFER_FAILED:${payload.requestId}`,
        metadata: {
          requestId: payload.requestId,
          projectId: payload.projectId,
          amount: payload.amount,
          status: payload.status,
          payosTransferStatus: payload.payosTransferStatus,
          payosTransferId: payload.payosTransferId
        }
      });

      logger.info('Đã tạo notification cho disbursement transfer thất bại.', {
        requestId: payload.requestId,
        organizationId: payload.organizationId
      });
    } catch (error) {
      logger.error('Tạo notification cho disbursement transfer failed thất bại.', {
        requestId: payload.requestId,
        errorMessage: (error as Error)?.message
      });
    }
  });

  logger.info('Notification bridge đã được khởi tạo.');
}
