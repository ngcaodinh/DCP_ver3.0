import mongoose, { Schema } from 'mongoose';

/**
 * Các loại notification nghiệp vụ trong hệ thống.
 * Mỗi loại có allowlist channel riêng (xem NOTIFICATION_ALLOWLIST ở notificationService).
 */
export type NotificationType =
  | 'DONATION_RECEIVED'
  | 'DISBURSEMENT_SIGNED'
  | 'PROJECT_APPROVED'
  | 'KYC_EXPIRING'
  | 'LARGE_DONATION'
  | 'DISBURSEMENT_COMPLETED'
  | 'MANUAL_REVIEW_ESCALATION'
  | 'OVERRIDE_APPROVED'
  | 'SBT_MINT_FAILED'
  | 'COMMITTEE_RESIGN_REQUIRED'
  | 'SYSTEM';

/**
 * Kênh gửi notification. Theo spec E1: chỉ routing + skeleton; delivery thật do E2.
 */
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'SMS';

/**
 * Mức độ ưu tiên — map sang Bull `priority` option.
 * - LOW = 4, NORMAL = 3, HIGH = 2, CRITICAL = 1 (Bull: thấp = chạy trước).
 */
export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

/**
 * Trạng thái gửi của từng channel riêng biệt.
 * Cho phép partial success: email fail nhưng in_app vẫn ok.
 */
export type ChannelDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * Trạng thái tổng của notification sau khi worker xử lý.
 */
export type NotificationDeliveryState = 'PENDING' | 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export type NotificationDeliveryStatusMap = {
  IN_APP: ChannelDeliveryStatus;
  EMAIL: ChannelDeliveryStatus;
  PUSH: ChannelDeliveryStatus;
  SMS: ChannelDeliveryStatus;
};

export type Notification = {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  isRead: boolean;
  metadata: Record<string, unknown>;
  /** Kênh đã được dispatch (cho FE filter dropdown nếu cần). */
  channels: NotificationChannel[];
  /** Mức ưu tiên — dùng để quyết định Bull priority + UI sort. */
  priority: NotificationPriority;
  /** Trạng thái delivery per channel — update sau khi worker xử lý. */
  deliveryStatus: NotificationDeliveryStatusMap;
  /** Trạng thái tổng — dùng cho query list/admin view. */
  deliveryState: NotificationDeliveryState;
  /** Số lần worker đã thử xử lý job này (cho debug + DLQ monitor). */
  attempts: number;
  /** Lỗi gần nhất (nếu có) — không log PII, chỉ message. */
  lastError?: string;
  /** Khóa nghiệp vụ để chống trùng (ví dụ "DISBURSEMENT_TRANSFERRED:REQ-001"). */
  deduplicationKey?: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Projection public cho notification list, loại bỏ user identity và delivery diagnostics nội bộ. */
export const NOTIFICATION_PUBLIC_PROJECTION = {
  _id: 0,
  notificationId: 1,
  notificationType: 1,
  title: 1,
  content: 1,
  isRead: 1,
  metadata: 1,
  channels: 1,
  createdAt: 1
} as const;

const channelDeliveryStatusSchema = new Schema(
  {
    channel: { type: String, required: true, enum: ['IN_APP', 'EMAIL', 'PUSH', 'SMS'] },
    status: { type: String, required: true, enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'], default: 'PENDING' }
  },
  { _id: false }
);

const notificationSchema = new Schema<Notification>(
  {
    notificationId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    notificationType: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    content: { type: String, required: true, trim: true, maxlength: 500 },
    isRead: { type: Boolean, required: true, default: false, index: true },
    metadata: { type: Schema.Types.Mixed, required: true, default: {} },
    // ─── E1 extensions ────────────────────────────────────────────────────────
    channels: {
      type: [String],
      required: true,
      enum: ['IN_APP', 'EMAIL', 'PUSH', 'SMS'] as const,
      default: ['IN_APP']
    },
    priority: {
      type: String,
      required: true,
      enum: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const,
      default: 'NORMAL',
      index: true
    },
    deliveryStatus: {
      IN_APP: { type: channelDeliveryStatusSchema, required: true },
      EMAIL: { type: channelDeliveryStatusSchema, required: true },
      PUSH: { type: channelDeliveryStatusSchema, required: true },
      SMS: { type: channelDeliveryStatusSchema, required: true }
    },
    deliveryState: {
      type: String,
      required: true,
      enum: ['PENDING', 'DELIVERED', 'PARTIAL', 'FAILED', 'SKIPPED'] as const,
      default: 'PENDING',
      index: true
    },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, required: false, maxlength: 1000 },
    deduplicationKey: { type: String, required: false, index: true, sparse: true }
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
// Phục vụ list notification theo user/type với thứ tự mới nhất trước, tránh lọc type ngoài index.
notificationSchema.index({ userId: 1, notificationType: 1, createdAt: -1 });
// Index phục vụ DLQ monitor (admin view) — filter notification FAILED theo thời gian.
notificationSchema.index({ deliveryState: 1, updatedAt: -1 });
// Sparse unique — chỉ enforce uniqueness khi có deduplicationKey (null không conflict).
notificationSchema.index(
  { deduplicationKey: 1 },
  { unique: true, partialFilterExpression: { deduplicationKey: { $type: 'string' } } }
);
// TTL index: tự động xóa notification sau 90 ngày để giảm storage và comply GDPR.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

export const NotificationModel = mongoose.models.Notification || mongoose.model<Notification>('Notification', notificationSchema);
