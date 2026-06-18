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

/** Hàm tạo notification ID duy nhất. Sử dụng crypto.randomUUID() để đảm bảo tính ngẫu nhiên cryptographic cho notificationId. */
function createNotificationId(): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const uuid = crypto.randomUUID(); // Format: 550e8400-e29b-41d4-a716-446655440000
  return `NOTI-${Date.now()}-${uuid.replace(/-/g, '').toUpperCase()}`;
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
