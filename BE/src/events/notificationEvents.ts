import { EventEmitter } from 'events';
import type { NotificationChannel, NotificationType } from '../models/notificationModel';

/**
 * Payload khi notification đã được delivered qua 1 channel cụ thể.
 * Side-effect consumer (E3 SSE controller, future per-user socket, push service) lắng nghe event này
 * để đẩy realtime tới client.
 *
 * Lưu ý: EventEmitter pattern giúp tách "delivery action" khỏi "delivery side-effect" —
 * E1 chỉ chịu trách nhiệm delivery qua DB + emit event; E2/E3 sẽ plug thêm transport.
 */
export type NotificationDeliveredEventPayload = {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  channel: NotificationChannel;
  title: string;
  content: string;
  deliveredAt: Date;
};

export type NotificationFailedEventPayload = {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  channel: NotificationChannel;
  errorMessage: string;
  failedAt: Date;
};

export const notificationEvents = new EventEmitter();
notificationEvents.setMaxListeners(100);