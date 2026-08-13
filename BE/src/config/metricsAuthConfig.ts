export const METRICS_AUTH_TOKEN_MIN_LENGTH = 32;
const OPTIONAL_METRICS_AUTH_ENVIRONMENTS = ['development', 'test'] as const;

/** Lấy bearer token metrics hiện tại, cho phép test và runtime thay đổi cấu hình mà không bị cache cũ. */
export function getMetricsAuthToken(): string | null {
  return process.env.METRICS_AUTH_TOKEN?.trim() || null;
}

/** Xác định hai môi trường local được phép chạy metrics không cần bearer token. */
export function isMetricsAuthOptionalEnvironment(): boolean {
  return OPTIONAL_METRICS_AUTH_ENVIRONMENTS.includes(
    process.env.NODE_ENV as (typeof OPTIONAL_METRICS_AUTH_ENVIRONMENTS)[number]
  );
}

/** Kiểm tra token metrics có đủ độ dài tối thiểu trước khi dùng làm credential runtime. */
export function isValidMetricsAuthToken(metricsAuthToken: string): boolean {
  return metricsAuthToken.length >= METRICS_AUTH_TOKEN_MIN_LENGTH;
}

/** Fail-fast khi thiếu token hoặc token đã cấu hình không đạt độ dài tối thiểu để bảo vệ endpoint Prometheus. */
export function validateMetricsAuthConfig(): void {
  const metricsAuthToken = getMetricsAuthToken();

  if (!metricsAuthToken) {
    if (isMetricsAuthOptionalEnvironment()) return;

    throw new Error('METRICS_AUTH_TOKEN must be configured outside development/test environments.');
  }

  if (!isValidMetricsAuthToken(metricsAuthToken)) {
    throw new Error(
      `METRICS_AUTH_TOKEN must be at least ${METRICS_AUTH_TOKEN_MIN_LENGTH} characters long.`
    );
  }
}
