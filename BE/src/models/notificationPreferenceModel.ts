import mongoose, { Schema } from 'mongoose';
import type { NotificationChannel, NotificationType } from './notificationModel';

/**
 * User preference cho mỗi (notificationType × channel).
 * Map<notificationType, Map<channel, enabled>> — flexible, không cần schema cứng cho từng type.
 * Ví dụ:
 *   preferences['DONATION_RECEIVED']['IN_APP'] = true
 *   preferences['DONATION_RECEIVED']['EMAIL']  = false
 *   preferences['LARGE_DONATION']['EMAIL']     = true
 *
 * Mặc định khi user chưa set preference → dùng DEFAULT_PREFERENCES ở notificationService.
 */
export type NotificationPreferencesMap = {
  [notificationType: string]: {
    IN_APP?: boolean;
    EMAIL?: boolean;
    PUSH?: boolean;
    SMS?: boolean;
    [channel: string]: boolean | undefined;
  };
};

export type UserNotificationPreference = {
  userId: string;
  preferences: NotificationPreferencesMap;
  /** Master switch: nếu false → skip toàn bộ notification dù type nào. */
  globalEnabled: boolean;
  /** Version tÄƒng nguyÃªn tá»­ sau má»—i cáº­p nháº­t Ä‘á»ƒ phÃ¡t hiá»‡n lost update giá»¯a nhiá»u client. */
  version: number;
  /** Token để user hủy đăng ký notification qua link email (không cần login). */
  unsubscribeToken?: string;
  createdAt: Date;
  updatedAt: Date;
};

const userNotificationPreferenceSchema = new Schema<UserNotificationPreference>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    // Map type/channel co the mo rong; service validate key truoc khi luu.
    // Mixed giu nguyen key tuong lai thay vi de Mongoose tu dong loai bo.
    preferences: { type: Schema.Types.Mixed, required: true, default: {} },
    globalEnabled: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, default: 0 },
    /** Token để user hủy đăng ký notification qua link email (không cần login). */
    unsubscribeToken: { type: String, sparse: true, index: true }
  },
  { timestamps: true }
);

export const UserNotificationPreferenceModel =
  mongoose.models.UserNotificationPreference ||
  mongoose.model<UserNotificationPreference>('UserNotificationPreference', userNotificationPreferenceSchema);

export type { NotificationChannel, NotificationType };
