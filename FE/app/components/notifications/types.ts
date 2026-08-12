/** Cấu trúc notification hiển thị trong dropdown, giữ metadata opaque cho đến khi BE công bố contract điều hướng. */
export interface NotificationItem {
  notificationId: string;
  notificationType: string;
  title: string;
  content: string;
  isRead: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  channels?: string[];
}

/** Thông tin phân trang trả về cùng danh sách notification. */
export interface NotificationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

/** Payload danh sách notification đã được unwrap từ API envelope. */
export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
  pagination: NotificationPagination;
}

/** Kết quả API sau khi đánh dấu một notification là đã đọc. */
export interface MarkNotificationReadResponse {
  notificationId: string;
}

/** Các kênh preference được BE cho phép mở rộng trong tương lai. */
export interface NotificationChannelPreferences {
  IN_APP?: boolean;
  EMAIL?: boolean;
  PUSH?: boolean;
  SMS?: boolean;
  [channel: string]: boolean | undefined;
}

/** Toàn bộ preference map canonical của người dùng; key không nhận diện vẫn phải được giữ nguyên khi PUT. */
export interface NotificationPreferencesMap {
  [notificationType: string]: NotificationChannelPreferences;
}

/** Payload preference canonical cho cả GET và PUT. */
export interface NotificationPreferencesResponse {
  globalEnabled: boolean;
  preferences: NotificationPreferencesMap;
  version?: number;
}

/** Kiểm tra object runtime mà không phụ thuộc vào schema hoặc thư viện validation mới. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PREFERENCE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_PREFERENCE_KEYS = new Set(['CONSTRUCTOR', 'PROTOTYPE']);

/** Giữ cùng quy tắc key với BE để không tạo prototype pollution từ response không tin cậy. */
function isSafePreferenceKey(key: string): boolean {
  return PREFERENCE_KEY_PATTERN.test(key) && !RESERVED_PREFERENCE_KEYS.has(key);
}

/** Chuẩn hóa response notification từ API trước khi đưa vào React Query cache. */
export function normalizeNotificationListResponse(value: unknown): NotificationListResponse {
  if (!isRecord(value) || !Array.isArray(value.notifications) || typeof value.unreadCount !== 'number' || !Number.isInteger(value.unreadCount) || value.unreadCount < 0 || !isRecord(value.pagination)) {
    throw new Error('Phản hồi danh sách thông báo không hợp lệ.');
  }

  const notifications = value.notifications.filter((notification): notification is NotificationItem => {
    if (!isRecord(notification)) {
      return false;
    }
    return typeof notification.notificationId === 'string'
      && notification.notificationId.length > 0
      && typeof notification.notificationType === 'string'
      && notification.notificationType.length > 0
      && typeof notification.title === 'string'
      && notification.title.length > 0
      && typeof notification.content === 'string'
      && notification.content.length > 0
      && typeof notification.isRead === 'boolean'
      && isRecord(notification.metadata)
      && typeof notification.createdAt === 'string'
      && notification.createdAt.length > 0
      && (notification.channels === undefined || (Array.isArray(notification.channels) && notification.channels.every((channel) => typeof channel === 'string')));
  });
  const pagination = value.pagination;
  const { page, limit, total, totalPages, hasNextPage } = pagination;
  if (
    notifications.length !== value.notifications.length
    || typeof page !== 'number'
    || !Number.isInteger(page)
    || page < 1
    || typeof limit !== 'number'
    || !Number.isInteger(limit)
    || limit < 1
    || limit > 20
    || typeof total !== 'number'
    || !Number.isInteger(total)
    || total < 0
    || typeof totalPages !== 'number'
    || !Number.isInteger(totalPages)
    || totalPages < 0
    || typeof hasNextPage !== 'boolean'
  ) {
    throw new Error('Phản hồi danh sách thông báo không hợp lệ.');
  }

  return {
    notifications,
    unreadCount: value.unreadCount,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage
    }
  };
}

/** Chuẩn hóa response mark-read để mutation không coi payload thành công giả là trạng thái hợp lệ. */
export function normalizeMarkNotificationReadResponse(value: unknown): MarkNotificationReadResponse {
  if (!isRecord(value) || typeof value.notificationId !== 'string' || value.notificationId.length === 0) {
    throw new Error('Phản hồi đánh dấu thông báo không hợp lệ.');
  }
  return { notificationId: value.notificationId };
}

/** Chuẩn hóa response preference từ API để tránh ghi dữ liệu sai cấu trúc vào cache. */
export function normalizeNotificationPreferencesResponse(value: unknown): NotificationPreferencesResponse {
  if (!isRecord(value) || typeof value.globalEnabled !== 'boolean' || !isRecord(value.preferences)) {
    throw new Error('Phản hồi cài đặt thông báo không hợp lệ.');
  }

  const preferences: NotificationPreferencesMap = {};
  for (const [notificationType, channels] of Object.entries(value.preferences)) {
    if (!isSafePreferenceKey(notificationType) || !isRecord(channels)) {
      throw new Error('Phản hồi cài đặt thông báo không hợp lệ.');
    }
    const normalizedChannels: NotificationChannelPreferences = {};
    for (const [channel, enabled] of Object.entries(channels)) {
      if (!isSafePreferenceKey(channel) || typeof enabled !== 'boolean') {
        throw new Error('Phản hồi cài đặt thông báo không hợp lệ.');
      }
      normalizedChannels[channel] = enabled;
    }
    preferences[notificationType] = normalizedChannels;
  }

  if (value.version !== undefined && (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0)) {
    throw new Error('Phản hồi cài đặt thông báo không hợp lệ.');
  }

  return {
    globalEnabled: value.globalEnabled,
    preferences,
    ...(typeof value.version === 'number' ? { version: value.version } : {})
  };
}

/** Năm notification type có email toggle được PO chốt cho E4. */
export const EMAIL_PREFERENCE_NOTIFICATION_TYPES = [
  'LARGE_DONATION',
  'DISBURSEMENT_COMPLETED',
  'MANUAL_REVIEW_ESCALATION',
  'OVERRIDE_APPROVED',
  'SBT_MINT_FAILED'
] as const;

export type EmailPreferenceNotificationType = (typeof EMAIL_PREFERENCE_NOTIFICATION_TYPES)[number];

/** Giá trị toggle email được chỉnh cục bộ trong NotificationPanel. */
export type EmailPreferenceValues = Record<EmailPreferenceNotificationType, boolean>;

/** Chỉ lấy năm giá trị EMAIL được render, mặc định false khi canonical map chưa có type tương ứng. */
export function getEmailPreferenceValues(preferences: NotificationPreferencesMap): EmailPreferenceValues {
  return EMAIL_PREFERENCE_NOTIFICATION_TYPES.reduce<EmailPreferenceValues>((values, notificationType) => {
    values[notificationType] = preferences[notificationType]?.EMAIL === true;
    return values;
  }, {} as EmailPreferenceValues);
}

/** Deep-clone canonical map rồi chỉ thay EMAIL của năm type được render để PUT không làm mất cấu hình ẩn. */
export function buildNotificationPreferenceUpdatePayload(
  currentPreferences: NotificationPreferencesResponse,
  emailValues: EmailPreferenceValues
): NotificationPreferencesResponse {
  const clonedPreferences = Object.fromEntries(
    Object.entries(currentPreferences.preferences).map(([notificationType, channels]) => [
      notificationType,
      { ...channels }
    ])
  ) as NotificationPreferencesMap;

  EMAIL_PREFERENCE_NOTIFICATION_TYPES.forEach((notificationType) => {
    clonedPreferences[notificationType] = {
      ...clonedPreferences[notificationType],
      EMAIL: emailValues[notificationType]
    };
  });

  const payload: NotificationPreferencesResponse = {
    globalEnabled: currentPreferences.globalEnabled,
    preferences: clonedPreferences
  };

  if (typeof currentPreferences.version === 'number') {
    payload.version = currentPreferences.version;
  }

  return payload;
}
