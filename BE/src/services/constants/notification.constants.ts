/**
 * Các hằng số cấu hình cho E2 — Multi-channel Delivery.
 * Tất cả các giá trị threshold, retry, timeout được đặt tại đây để dễ thay đổi.
 */

/**
 * Danh sách event types được phép gửi EMAIL.
 * Chỉ các event này mới trigger EMAIL channel; các event khác chỉ IN_APP.
 */
export const EMAIL_ALLOWLIST_EVENT_TYPES = [
  'LARGE_DONATION',
  'DISBURSEMENT_COMPLETED',
  'MANUAL_REVIEW_ESCALATION',
  'OVERRIDE_APPROVED',
  'SBT_MINT_FAILED'
] as const;

/**
 * Ngưỡng donation lớn để trigger EMAIL notification.
 * Mặc định: 10 triệu VND.
 */
export const DEFAULT_LARGE_DONATION_THRESHOLD_VND = 10_000_000;

/**
 * Số lần retry tối đa cho EMAIL channel trước khi fallback.
 * Spec: retry 3 lần với interval 1 phút.
 */
export const EMAIL_MAX_RETRY_ATTEMPTS = 3;

/**
 * Khoảng thời gian giữa các lần retry EMAIL (ms).
 * 1 phút = 60,000 ms.
 */
export const EMAIL_RETRY_INTERVAL_MS = 60_000;

/**
 * Timeout cho việc gửi EMAIL qua SMTP (ms).
 * 30 giây — đủ để Gmail xử lý.
 */
export const EMAIL_TIMEOUT_MS = 30_000;

/**
 * Timeout cho FCM push notification (ms).
 */
export const PUSH_TIMEOUT_MS = 10_000;

/**
 * Timeout cho Twilio SMS API (ms).
 */
export const SMS_TIMEOUT_MS = 15_000;

/**
 * Base URL cho unsubscribe link trong email.
 * Resolve theo thứ tự: FRONTEND_URL env var → fallback (chỉ dùng cho dev).
 *
 * Lưu ý: production BẮT BUỘC phải set FRONTEND_URL.
 * Nếu thiếu, getResolvedUnsubscribeBaseUrl() sẽ throw để gửi email bị block —
 * ưu tiên fail-fast hơn là gửi link sai (localhost) cho user thật.
 */
export const DEFAULT_UNSUBSCRIBE_BASE_URL = 'http://localhost:3000/settings/notifications';

/**
 * Map notification type → email template file name (không extension).
 * Single source of truth — thêm/sửa template chỉ cần update map này.
 */
export const NOTIFICATION_EMAIL_TEMPLATE_MAP: Record<string, string> = {
  LARGE_DONATION: 'large-donation',
  DISBURSEMENT_COMPLETED: 'disbursement-completed',
  MANUAL_REVIEW_ESCALATION: 'manual-review-escalation',
  OVERRIDE_APPROVED: 'override-approved',
  SBT_MINT_FAILED: 'sbt-mint-failed'
};

/**
 * Resolve unsubscribe base URL với guard production.
 * @returns Resolved URL
 * @throws Error khi thiếu FRONTEND_URL và NODE_ENV=production
 */
export function getResolvedUnsubscribeBaseUrl(): string {
  const fromEnv = process.env.FRONTEND_URL;
  if (fromEnv && fromEnv.length > 0) {
    return `${fromEnv.replace(/\/$/, '')}/settings/notifications`;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[notification] FRONTEND_URL env var là bắt buộc trong production — ' +
      'không fallback về localhost vì sẽ gửi link sai cho user.'
    );
  }
  return DEFAULT_UNSUBSCRIBE_BASE_URL;
}

/**
 * Các notification type hiển thị trong dropdown thông báo.
 * Single source of truth — tránh duplicate array rải rác nhiều nơi.
 */
export const VISIBLE_NOTIFICATION_TYPES = [
  'DONATION_RECEIVED',
  'DISBURSEMENT_SIGNED',
  'LARGE_DONATION',
  'DISBURSEMENT_COMPLETED',
  'OVERRIDE_APPROVED',
  'SBT_MINT_FAILED',
  'COMMITTEE_RESIGN_REQUIRED'
] as const;

/**
 * Custom error class cho validation errors trong notification service.
 * Dùng typed error codes thay vì string matching trong controller.
 */
export class NotificationValidationError extends Error {
  public readonly code: 'INVALID_TYPE' | 'INVALID_CHANNEL' | 'INVALID_VERSION' | 'CONFLICT';

  constructor(code: 'INVALID_TYPE' | 'INVALID_CHANNEL' | 'INVALID_VERSION' | 'CONFLICT', detail: string) {
    super(detail);
    this.name = 'NotificationValidationError';
    this.code = code;
  }
}
