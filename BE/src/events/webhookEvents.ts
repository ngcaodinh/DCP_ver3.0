import { EventEmitter } from 'events';

/**
 * EventEmitter cho sự kiện webhook PayOS.
 * Dùng làm cầu nối tạm thời giữa webhook handler và notification service
 * cho đến khi E1 notification service được triển khai đầy đủ.
 */
export const webhookEvents = new EventEmitter();
webhookEvents.setMaxListeners(100);

/**
 * Loại sự kiện webhook.
 * DISBURSEMENT_TRANSFERRED: Khi giải ngân được chuyển thành công.
 * DISBURSEMENT_TRANSFER_FAILED: Khi chuyển khoản giải ngân thất bại.
 */
export type WebhookEventType = 'DISBURSEMENT_TRANSFERRED' | 'DISBURSEMENT_TRANSFER_FAILED';

/**
 * Payload cho sự kiện webhook disbursement.
 */
export type DisbursementWebhookEventPayload = {
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  status: string;
  payosTransferStatus: string;
  payosTransferId: string | null;
  transactionHash: string | null;
};
