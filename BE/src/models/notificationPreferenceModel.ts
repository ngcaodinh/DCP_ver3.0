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
  };
};

export type UserNotificationPreference = {
  userId: string;
  preferences: NotificationPreferencesMap;
  /** Master switch: nếu false → skip toàn bộ notification dù type nào. */
  globalEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const preferencesSchema = new Schema<NotificationPreferencesMap>(
  {
    type: Schema.Types.Mixed,
    default: {}
  },
  { _id: false }
);

const userNotificationPreferenceSchema = new Schema<UserNotificationPreference>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    preferences: { type: preferencesSchema, required: true, default: {} },
    globalEnabled: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

export const UserNotificationPreferenceModel =
  mongoose.models.UserNotificationPreference ||
  mongoose.model<UserNotificationPreference>('UserNotificationPreference', userNotificationPreferenceSchema);

export type { NotificationChannel, NotificationType };