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
 * Sẽ được override bởi FRONTEND_URL env var nếu có.
 */
export const DEFAULT_UNSUBSCRIBE_BASE_URL = 'http://localhost:3000/settings/notifications';
