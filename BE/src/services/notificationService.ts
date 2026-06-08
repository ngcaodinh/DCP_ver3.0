import { NotificationModel, type Notification, type NotificationType } from '../models/notificationModel';
import { getLogger } from '../config/logger';

const logger = getLogger();

export type NotificationListResult = {
  notifications: Notification[];
  unreadCount: number;
};

type CreateNotificationPayload = {
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  deduplicationKey?: string;
};

/** Hàm tạo mã thông báo an toàn. Mục đích: sinh khóa duy nhất đủ khó đoán để lưu notification. */
function createNotificationId(): string {
  return `NOTI-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

/** Hàm tạo thông báo cho người dùng. Mục đích: lưu một notification mới và tránh trùng theo khóa nghiệp vụ nếu có. */
export async function createUserNotification(payload: CreateNotificationPayload): Promise<Notification> {
  const notificationId = payload.deduplicationKey || createNotificationId();

  const notification = await NotificationModel.findOneAndUpdate(
    { notificationId },
    {
      $setOnInsert: {
        notificationId,
        userId: payload.userId,
        notificationType: payload.notificationType,
        title: payload.title,
        content: payload.content,
        isRead: false,
        metadata: payload.metadata || {}
      }
    },
    { upsert: true, returnDocument: 'after' }
  ).lean<Notification>().exec();

  logger.info(`Đã tạo hoặc giữ nguyên thông báo người dùng. notificationId=${notificationId} userId=${payload.userId} notificationType=${payload.notificationType}`);

  return notification as Notification;
}

/** Hàm lấy danh sách thông báo của người dùng. Mục đích: cung cấp dữ liệu thật cho dropdown thông báo. */
export async function getUserNotifications(userId: string): Promise<NotificationListResult> {
  const visibleNotificationTypes: NotificationType[] = ['DONATION_RECEIVED', 'DISBURSEMENT_SIGNED'];
  const [notifications, unreadCount] = await Promise.all([
    NotificationModel.find({ userId, notificationType: { $in: visibleNotificationTypes } }).sort({ createdAt: -1 }).limit(100).lean<Notification[]>(),
    NotificationModel.countDocuments({ userId, notificationType: { $in: visibleNotificationTypes }, isRead: false })
  ]);

  return { notifications, unreadCount };
}

/** Hàm đánh dấu tất cả thông báo đã đọc. Mục đích: xóa badge chưa đọc của người dùng hiện tại. */
export async function markAllUserNotificationsAsRead(userId: string): Promise<NotificationListResult> {
  const visibleNotificationTypes: NotificationType[] = ['DONATION_RECEIVED', 'DISBURSEMENT_SIGNED'];
  await NotificationModel.updateMany({ userId, notificationType: { $in: visibleNotificationTypes }, isRead: false }, { $set: { isRead: true } });
  return getUserNotifications(userId);
}
