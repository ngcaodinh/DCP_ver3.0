/**
 * Cấu hình Sentry đọc từ biến môi trường.
 * Mục đích: tách khỏi instrumentation để test import được mà không kích hoạt Sentry.init().
 * Đọc process.env mỗi lần gọi, không cache để hỗ trợ test và runtime thay đổi cấu hình.
 */

const DEFAULT_PRODUCTION_TRACES_SAMPLE_RATE = 0.1;

/** Lấy DSN đã trim; chuỗi rỗng được xem là chưa cấu hình. */
export function getSentryDsn(): string | null {
  return process.env.SENTRY_DSN?.trim() || null;
}

/** Xác định môi trường test để suite chạy offline và deterministic. */
export function isSentryTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

/** Xác định Sentry có được phép khởi tạo và gửi event hay không. */
export function isSentryEnabled(): boolean {
  return Boolean(getSentryDsn()) && !isSentryTestEnvironment();
}

/** Lấy nhãn environment trên dashboard, tách khỏi NODE_ENV để hỗ trợ staging. */
export function getSentryEnvironment(): string {
  return process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development';
}

/** Lấy release phải khớp với giá trị lúc build để Sentry ghép source map. */
export function getSentryRelease(): string | undefined {
  return process.env.SENTRY_RELEASE?.trim() || undefined;
}

/**
 * Phân biệt API process và worker process dựng từ cùng một image.
 * @returns Tên process hiển thị trên dashboard Sentry.
 */
export function resolveSentryServerName(): string {
  if (process.env.SENTRY_SERVER_NAME?.trim()) return process.env.SENTRY_SERVER_NAME.trim();
  return process.env.RUN_WORKERS === 'true' ? 'dcp-backend-worker' : 'dcp-backend';
}

/**
 * Đọc tỉ lệ lấy mẫu transaction cho production.
 * Giá trị ngoài [0, 1] hoặc không parse được sẽ dùng mặc định để tránh tắt tracing ngoài ý muốn.
 */
export function getConfiguredTracesSampleRate(): number {
  const rawSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim();
  if (!rawSampleRate) return DEFAULT_PRODUCTION_TRACES_SAMPLE_RATE;

  const parsedSampleRate = Number(rawSampleRate);
  return Number.isFinite(parsedSampleRate) && parsedSampleRate >= 0 && parsedSampleRate <= 1
    ? parsedSampleRate
    : DEFAULT_PRODUCTION_TRACES_SAMPLE_RATE;
}

/**
 * Tạo cảnh báo khi production thiếu DSN.
 * Không throw vì Sentry là tầng quan sát, không được biến thiếu cấu hình thành outage.
 * @returns Thông điệp cảnh báo nếu thiếu DSN, hoặc null khi cấu hình hợp lệ.
 */
export function getSentryConfigWarning(): string | null {
  if (process.env.NODE_ENV !== 'production') return null;
  if (getSentryDsn()) return null;

  return 'SENTRY_DSN chưa được cấu hình — production đang chạy không có error tracking.';
}
