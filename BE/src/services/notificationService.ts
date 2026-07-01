import {
  NotificationModel,
  type Notification,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationType,
  type NotificationDeliveryStatusMap,
  type NotificationDeliveryState
} from '../models/notificationModel';
export type { NotificationDeliveryStatusMap };
import { UserNotificationPreferenceModel } from '../models/notificationPreferenceModel';
import type { NotificationPreferencesMap } from '../models/notificationPreferenceModel';
import { getLogger } from '../config/logger';
import { enqueueNotification, NOTIFICATION_ALLOWLIST } from '../queues/notificationQueue';
import { VISIBLE_NOTIFICATION_TYPES, NotificationValidationError } from './constants/notification.constants';
import crypto from 'crypto';

const logger = getLogger();

export type NotificationListResult = {
  notifications: Notification[];
  unreadCount: number;
};

export type CreateNotificationPayload = {
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  deduplicationKey?: string;
  /** Kênh mong muốn — sẽ được filter qua user preference + allowlist. */
  channels?: NotificationChannel[];
  /** Mức ưu tiên — default NORMAL. */
  priority?: NotificationPriority;
  /** Nguồn enqueue cho audit log — 'bridge' | 'api' | 'system'. */
  enqueuedBy?: string;
  /**
   * Nếu true → ghi thẳng vào DB và return notification (backward compat).
   * Nếu false (default) → enqueue qua Bull queue + return null.
   * Caller cũ (SSE controller, manual review worker) dùng direct=true để không phụ thuộc queue.
   */
  directInsert?: boolean;
};

/**
 * Hàm tạo notification ID duy nhất. Sử dụng crypto.randomUUID() để đảm bảo tính ngẫu nhiên cryptographic cho notificationId.
 */
function createNotificationId(): string {
  const uuid = crypto.randomUUID();
  return `NOTI-${Date.now()}-${uuid.replace(/-/g, '').toUpperCase()}`;
}

/**
 * Default preference khi user chưa có bản ghi — áp dụng policy "opt-out cho non-IN_APP".
 * Lý do: mặc định user chỉ nhận IN_APP; các channel khác (EMAIL/PUSH/SMS) chỉ bật khi user
 * explicit opt-in qua API E3. Tránh spam email khi user mới đăng ký.
 */
function getDefaultChannelEnabled(notificationType: NotificationType, channel: NotificationChannel): boolean {
  if (channel === 'IN_APP') return true;
  // Channel ngoài IN_APP chỉ bật cho event type critical theo allowlist policy.
  const criticalTypes: NotificationType[] = [
    'LARGE_DONATION',
    'DISBURSEMENT_COMPLETED',
    'MANUAL_REVIEW_ESCALATION',
    'OVERRIDE_APPROVED',
    'SBT_MINT_FAILED'
  ];
  return criticalTypes.includes(notificationType);
}

/**
 * Hàm resolve channel đã enable cho user × notificationType dựa trên preference + allowlist.
 *
 * Logic:
 * 1. Nếu user có preference record → dùng preference (override default).
 * 2. Nếu không có → dùng default policy (IN_APP on, others opt-in).
 * 3. Nếu globalEnabled=false → trả về mảng rỗng (skip toàn bộ).
 * 4. Luôn intersect với NOTIFICATION_ALLOWLIST (channel không trong allowlist → bỏ).
 */
export async function resolveEnabledChannels(
  userId: string,
  notificationType: NotificationType,
  requestedChannels: NotificationChannel[]
): Promise<NotificationChannel[]> {
  const allowed = NOTIFICATION_ALLOWLIST[notificationType] ?? ['IN_APP'];
  // 1. Filter requested theo allowlist.
  let candidate = requestedChannels.filter(ch => allowed.includes(ch));
  if (candidate.length === 0) {
    return [];
  }

  // 2. Áp dụng user preference.
  const preferenceRecord = await UserNotificationPreferenceModel.findOne({ userId }).lean().exec();
  if (preferenceRecord && !preferenceRecord.globalEnabled) {
    return [];
  }

  const userPrefs = preferenceRecord?.preferences?.[notificationType];
  if (!userPrefs) {
    // Không có preference riêng cho type → dùng default.
    candidate = candidate.filter(ch => getDefaultChannelEnabled(notificationType, ch));
  } else {
    candidate = candidate.filter(ch => {
      const prefValue = userPrefs[ch];
      // null/undefined → dùng default; true/false → dùng giá trị đó.
      if (prefValue === undefined) return getDefaultChannelEnabled(notificationType, ch);
      return prefValue === true;
    });
  }

  return candidate;
}

/**
 * Hàm tạo hoặc idempotent-upsert notification vào DB.
 * Mục đích: nếu deduplicationKey đã tồn tại → giữ nguyên record cũ (idempotent).
 */
async function upsertNotificationRecord(payload: {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  deduplicationKey?: string;
}): Promise<Notification> {
  const notification = await NotificationModel.findOneAndUpdate(
    { notificationId: payload.notificationId },
    {
      $setOnInsert: {
        notificationId: payload.notificationId,
        userId: payload.userId,
        notificationType: payload.notificationType,
        title: payload.title,
        content: payload.content,
        isRead: false,
        metadata: payload.metadata,
        channels: payload.channels,
        priority: payload.priority,
        deduplicationKey: payload.deduplicationKey,
        deliveryStatus: {
          IN_APP: 'PENDING',
          EMAIL: 'PENDING',
          PUSH: 'PENDING',
          SMS: 'PENDING'
        } satisfies NotificationDeliveryStatusMap,
        deliveryState: 'PENDING' as NotificationDeliveryState,
        attempts: 0
      }
    },
    { upsert: true, returnDocument: 'after' }
  ).lean<Notification>().exec();

  return notification as Notification;
}

/**
 * Hàm tạo thông báo cho người dùng — entry point chính.
 *
 * Mục đích:
 * - Nếu payload.directInsert=true → ghi thẳng DB (backward compat cho SSE/legacy caller).
 * - Nếu không → resolve enabled channels qua user preference + allowlist, upsert DB record,
 *   rồi enqueue job qua Bull queue để worker xử lý async.
 *
 * Hành vi khi tất cả channel bị skip:
 * - Lưu record với deliveryState='SKIPPED' và channels=[] (để admin trace).
 * - KHÔNG enqueue queue (không có gì để worker xử lý).
 *
 * Hành vi khi enqueue fail (queue không khả dụng):
 * - Record vẫn ở DB với deliveryState='PENDING' → có thể replay qua admin tool sau.
 * - Log warning, không throw (không block caller).
 */
export async function createUserNotification(payload: CreateNotificationPayload): Promise<Notification | null> {
  const notificationId = payload.deduplicationKey || createNotificationId();
  const requestedChannels = payload.channels ?? ['IN_APP'];
  const priority = payload.priority ?? 'NORMAL';
  const metadata = payload.metadata ?? {};

  // Resolve channels theo user preference + allowlist.
  const enabledChannels = await resolveEnabledChannels(
    payload.userId,
    payload.notificationType,
    requestedChannels
  );

  if (enabledChannels.length === 0) {
    // Tất cả channel bị skip — ghi record với channels=[] để audit.
    const skippedNotification = await upsertNotificationRecord({
      notificationId,
      userId: payload.userId,
      notificationType: payload.notificationType,
      title: payload.title,
      content: payload.content,
      metadata,
      channels: [],
      priority,
      deduplicationKey: payload.deduplicationKey
    });

    logger.info('Notification đã bị skip do user preference hoặc allowlist.', {
      notificationId,
      userId: payload.userId,
      notificationType: payload.notificationType,
      requestedChannels: JSON.stringify(requestedChannels)
    });

    return skippedNotification;
  }

  // Upsert record với channels đã resolve.
  const notification = await upsertNotificationRecord({
    notificationId,
    userId: payload.userId,
    notificationType: payload.notificationType,
    title: payload.title,
    content: payload.content,
    metadata,
    channels: enabledChannels,
    priority,
    deduplicationKey: payload.deduplicationKey
  });

  // Direct insert mode — không qua queue, return record luôn.
  if (payload.directInsert === true) {
    logger.info(`Đã tạo hoặc giữ nguyên thông báo người dùng (direct). notificationId=${notificationId} userId=${payload.userId}`);
    return notification;
  }

  // Enqueue qua Bull queue.
  const enqueueResult = await enqueueNotification(
    {
      notificationId,
      userId: payload.userId,
      notificationType: payload.notificationType,
      title: payload.title,
      content: payload.content,
      channels: enabledChannels,
      priority,
      metadata,
      deduplicationKey: payload.deduplicationKey,
      attemptNumber: 1,
      enqueuedBy: payload.enqueuedBy ?? 'system'
    }
  );

  if (!enqueueResult.enqueued) {
    logger.warn('Notification đã lưu DB nhưng không enqueue được queue (Redis down?).', {
      notificationId,
      userId: payload.userId
    });
  }

  return notification;
}

/**
 * Hàm lấy danh sách thông báo của người dùng. Mục đích: cung cấp dữ liệu thật cho dropdown thông báo.
 */
export async function getUserNotifications(userId: string): Promise<NotificationListResult> {
  const [notifications, unreadCount] = await Promise.all([
    NotificationModel.find({ userId, notificationType: { $in: VISIBLE_NOTIFICATION_TYPES } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<Notification[]>(),
    NotificationModel.countDocuments({
      userId,
      notificationType: { $in: VISIBLE_NOTIFICATION_TYPES },
      isRead: false
    })
  ]);

  return { notifications, unreadCount };
}

/**
 * Hàm đánh dấu tất cả thông báo đã đọc. Mục đích: xóa badge chưa đọc của người dùng hiện tại.
 */
export async function markAllUserNotificationsAsRead(userId: string): Promise<NotificationListResult> {
  await NotificationModel.updateMany(
    { userId, notificationType: { $in: VISIBLE_NOTIFICATION_TYPES }, isRead: false },
    { $set: { isRead: true } }
  );
  return getUserNotifications(userId);
}

/**
 * Hàm lấy notification theo ID — dùng cho worker update state sau khi deliver.
 * Trả về null nếu không tìm thấy (race với admin delete).
 */
export async function findNotificationById(notificationId: string): Promise<Notification | null> {
  const result = await NotificationModel.findOne({ notificationId }).lean<Notification>().exec();
  return result as Notification | null;
}

/**
 * Hàm đánh dấu 1 notification là đã đọc.
 * Chỉ cho phép user đánh dấu notification thuộc về mình (IDOR prevention).
 *
 * @param notificationId ID của notification
 * @param userId ID của user (từ auth context)
 * @returns Notification đã được cập nhật, hoặc null nếu không tìm thấy / không thuộc user
 */
export async function markNotificationAsRead(notificationId: string, userId: string): Promise<Notification | null> {
  const result = await NotificationModel.findOneAndUpdate(
    { notificationId, userId, isRead: false },
    { $set: { isRead: true } },
    { returnDocument: 'after' }
  ).lean<Notification>().exec();

  return result as Notification | null;
}

/**
 * Hàm đánh dấu nhiều notifications là đã đọc trong 1 query.
 * Dùng cho mark-all (nhưng spec E3 chỉ yêu cầu mark-all cụ thể, nên giữ helper).
 *
 * @param notificationIds Danh sách ID notifications cần đánh dấu
 * @param userId ID của user
 * @returns Số lượng notifications đã được cập nhật
 */
export async function markMultipleNotificationsAsRead(
  notificationIds: string[],
  userId: string
): Promise<number> {
  if (notificationIds.length === 0) return 0;
  const result = await NotificationModel.updateMany(
    { notificationId: { $in: notificationIds }, userId, isRead: false },
    { $set: { isRead: true } }
  );
  return result.modifiedCount;
}

/**
 * Hàm lấy user preferences cho notification.
 * Nếu chưa có record → tạo mới với default preferences (opt-out ngoài IN_APP).
 *
 * @param userId ID của người dùng
 * @returns UserNotificationPreference record
 */
export async function getUserPreferences(userId: string): Promise<{
  globalEnabled: boolean;
  preferences: NotificationPreferencesMap;
}> {
  let pref = await UserNotificationPreferenceModel.findOne({ userId }).lean().exec();

  if (!pref) {
    pref = await UserNotificationPreferenceModel.create({
      userId,
      preferences: {},
      globalEnabled: true,
      unsubscribeToken: undefined
    });
    return { globalEnabled: pref.globalEnabled, preferences: pref.preferences };
  }

  return { globalEnabled: pref.globalEnabled, preferences: pref.preferences };
}

/**
 * Hàm cập nhật user preferences cho notification.
 * Validate payload và merge với preferences hiện tại.
 *
 * @param userId ID của người dùng
 * @param payload Payload cập nhật từ client
 * @returns Updated preferences
 */
const ALL_NOTIFICATION_TYPES = [
  'DONATION_RECEIVED',
  'DISBURSEMENT_SIGNED',
  'PROJECT_APPROVED',
  'KYC_EXPIRING',
  'LARGE_DONATION',
  'DISBURSEMENT_COMPLETED',
  'MANUAL_REVIEW_ESCALATION',
  'OVERRIDE_APPROVED',
  'SBT_MINT_FAILED',
  'SYSTEM'
] as const;

const ALL_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH', 'SMS'] as const;

export async function updateUserPreferences(
  userId: string,
  payload: {
    globalEnabled?: boolean;
    preferences?: NotificationPreferencesMap;
  }
): Promise<{
  globalEnabled: boolean;
  preferences: NotificationPreferencesMap;
}> {
  const updateFields: Record<string, unknown> = {};

  if (typeof payload.globalEnabled === 'boolean') {
    updateFields.globalEnabled = payload.globalEnabled;
  }

  if (payload.preferences !== undefined) {
    for (const [notificationType, channels] of Object.entries(payload.preferences)) {
      if (!ALL_NOTIFICATION_TYPES.includes(notificationType as typeof ALL_NOTIFICATION_TYPES[number])) {
        throw new NotificationValidationError('INVALID_TYPE', `Loại thông báo không hợp lệ: ${notificationType}`);
      }

      if (channels && typeof channels === 'object') {
        for (const channel of Object.keys(channels)) {
          if (!ALL_CHANNELS.includes(channel as typeof ALL_CHANNELS[number])) {
            throw new NotificationValidationError('INVALID_CHANNEL', `Kênh không hợp lệ: ${channel}`);
          }
        }
      }
    }
    updateFields.preferences = payload.preferences;
  }

  const updated = await UserNotificationPreferenceModel.findOneAndUpdate(
    { userId },
    { $set: updateFields },
    { upsert: true, returnDocument: 'after', runValidators: true }
  ).lean().exec();

  return {
    globalEnabled: (updated as { globalEnabled: boolean }).globalEnabled,
    preferences: (updated as { preferences: NotificationPreferencesMap }).preferences
  };
}

/**
 * Xóa 1 notification của user.
 * Chỉ cho phép user xóa notification thuộc về mình (IDOR prevention).
 *
 * @param notificationId ID của notification cần xóa
 * @param userId ID của user (từ auth context)
 * @returns true nếu đã xóa, false nếu không tìm thấy hoặc không thuộc user
 */
export async function deleteUserNotification(notificationId: string, userId: string): Promise<boolean> {
  const result = await NotificationModel.deleteOne({ notificationId, userId }).exec();
  return result.deletedCount > 0;
}

/**
 * Lấy số notification chưa đọc của user.
 * Dùng cho badge count trên notification bell icon.
 *
 * @param userId ID của người dùng
 * @returns Số lượng notification chưa đọc
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const count = await NotificationModel.countDocuments({
    userId,
    notificationType: { $in: VISIBLE_NOTIFICATION_TYPES },
    isRead: false
  }).exec();
  return count;
}

/**
 * Hàm cập nhật delivery state của notification sau khi worker xử lý.
 * Mục đích: đồng bộ DB với kết quả dispatch thực tế.
 */
export async function updateNotificationDeliveryStatus(params: {
  notificationId: string;
  deliveryStatus: NotificationDeliveryStatusMap;
  deliveryState: NotificationDeliveryState;
  attempts: number;
  lastError?: string;
}): Promise<void> {
  const update: Record<string, unknown> = {
    deliveryStatus: params.deliveryStatus,
    deliveryState: params.deliveryState,
    attempts: params.attempts
  };
  if (params.lastError !== undefined) {
    update.lastError = params.lastError;
  }

  await NotificationModel.updateOne({ notificationId: params.notificationId }, { $set: update }).exec();
}

/**
 * Hàm cập nhật 1 channel status trong deliveryStatus map.
 * Mục đích: helper cho worker update từng channel độc lập (partial update).
 */
export function updateChannelStatus(
  currentStatus: NotificationDeliveryStatusMap,
  channel: NotificationChannel,
  newStatus: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'
): NotificationDeliveryStatusMap {
  return { ...currentStatus, [channel]: newStatus };
}

/**
 * Hàm tính trạng thái tổng (deliveryState) dựa trên per-channel status.
 * - Nếu tất cả channel được phép đều SENT → DELIVERED.
 * - Nếu có ≥1 SENT và ≥1 FAILED → PARTIAL.
 * - Nếu tất cả SKIPPED → SKIPPED.
 * - Nếu tất cả FAILED hoặc PENDING → FAILED.
 */
export function computeDeliveryState(
  deliveryStatus: NotificationDeliveryStatusMap,
  requestedChannels: NotificationChannel[]
): NotificationDeliveryState {
  if (requestedChannels.length === 0) {
    return 'SKIPPED';
  }

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const channel of requestedChannels) {
    const status = deliveryStatus[channel];
    if (status === 'SENT') sentCount += 1;
    else if (status === 'FAILED') failedCount += 1;
    else if (status === 'SKIPPED') skippedCount += 1;
  }

  if (sentCount === requestedChannels.length) return 'DELIVERED';
  if (skippedCount === requestedChannels.length) return 'SKIPPED';
  if (sentCount > 0 && (failedCount > 0 || skippedCount > 0)) return 'PARTIAL';
  return 'FAILED';
}

/**
 * Tạo token ngẫu nhiên để hủy đăng ký notification qua email.
 * @param userId ID của người dùng
 * @returns Token unsubscribe dạng hex 64 ký tự
 */
export async function generateUnsubscribeToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await UserNotificationPreferenceModel.findOneAndUpdate(
    { userId },
    { $set: { unsubscribeToken: token } },
    { upsert: true, new: true }
  );
  return token;
}

/**
 * Lay unsubscribe token cua user tu UserNotificationPreference.
 * Dung boi E2 dispatcher de tao email unsubscribe link.
 *
 * @param userId ID cua nguoi dung
 * @returns Unsubscribe token hoac null neu user chua co preference record
 */
export async function getUnsubscribeTokenForUser(userId: string): Promise<string | null> {
  const pref = await UserNotificationPreferenceModel.findOne({ userId }).lean().exec();
  return pref?.unsubscribeToken ?? null;
}

/**
 * Xử lý hủy đăng ký notification qua token từ email.
 * @param token Token từ link unsubscribe trong email
 * @returns True nếu hủy thành công, false nếu token không hợp lệ
 */
export async function processUnsubscribe(token: string): Promise<boolean> {
  const pref = await UserNotificationPreferenceModel.findOne({ unsubscribeToken: token });
  if (!pref) return false;
  pref.globalEnabled = false;
  await pref.save();
  return true;
}