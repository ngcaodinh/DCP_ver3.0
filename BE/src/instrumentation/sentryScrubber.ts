/**
 * Chính sách scrub và sampling cho Sentry.
 * Mục đích: tách logic thuần khỏi module có side effect Sentry.init để unit test offline.
 * exception.values[].stacktrace tuyệt đối không đi qua redactSensitiveData để giữ source map.
 */
import type { Breadcrumb, Event } from '@sentry/node';
import { redactSensitiveData } from '../utils/redactSensitiveData';
import { sanitizeProviderError, sanitizeProviderLogMessage } from '../utils/sanitizeProviderError';

/** Header an toàn được giữ lại; header không nằm trong allowlist mặc định bị loại. */
const ALLOWED_REQUEST_HEADERS = new Set([
  'content-type',
  'content-length',
  'accept',
  'x-request-id'
]);

/** Breadcrumb console trùng lặp Winston và có thể mang tham số chưa redact. */
const DROPPED_BREADCRUMB_CATEGORIES = new Set(['console']);

/** Route hạ tầng không lấy mẫu để tránh tiêu quota cho health check và metrics. */
const UNSAMPLED_TRANSACTION_PATTERNS = ['/health', '/ready', '/live', '/metrics'];

/** Cắt query string và fragment vì token, OTP và mã claim thường nằm ở đó. */
function stripQueryString(urlValue: unknown): string | undefined {
  if (typeof urlValue !== 'string' || !urlValue) return undefined;

  const separatorIndex = urlValue.search(/[?#]/);
  return separatorIndex === -1 ? urlValue : urlValue.slice(0, separatorIndex);
}

/** Lọc header theo allowlist và giữ nguyên key gốc để không ảnh hưởng debug hợp lệ. */
function filterRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const filteredHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(headerName.toLowerCase())) {
      filteredHeaders[headerName] = headerValue;
    }
  }

  return filteredHeaders;
}

/**
 * Redact event trước khi rời process.
 * @param event Event do Sentry SDK dựng, được mutate theo contract beforeSend.
 * @param requestId Correlation ID từ ALS, null khi ngoài request scope.
 * @returns Chính event đã được scrub.
 */
export function redactSentryEvent<T extends Event>(event: T, requestId: string | null): T {
  // Event từ process-level integration không đi qua reporter nên cần requestId làm lưới an toàn.
  if (requestId && !event.tags?.requestId) {
    event.tags = { ...event.tags, requestId };
  }

  if (event.extra) {
    event.extra = redactSensitiveData(event.extra);
  }
  if (event.user) {
    event.user = redactSensitiveData(event.user) as Event['user'];
  }
  if (event.tags) {
    event.tags = redactSensitiveData(event.tags) as Event['tags'];
  }

  // Giữ trace_id/span_id nguyên vẹn để không cắt đứt distributed trace.
  if (event.contexts) {
    const { trace: traceContext, ...customContexts } = event.contexts;
    const redactedContexts = (redactSensitiveData(customContexts) ?? {}) as Event['contexts'];
    event.contexts = traceContext === undefined
      ? redactedContexts
      : { ...redactedContexts, trace: traceContext };
  }

  // Dựng lại request bằng allowlist để body, cookie, query_string và header lạ không lọt ra ngoài.
  if (event.request) {
    event.request = {
      url: stripQueryString(event.request.url),
      method: event.request.method,
      headers: filterRequestHeaders(event.request.headers)
    };
  }

  if (typeof event.message === 'string') {
    event.message = sanitizeProviderLogMessage(event.message);
  }

  // Chỉ sanitize message của exception; stacktrace phải giữ nguyên tuyệt đối cho source map.
  for (const exceptionValue of event.exception?.values ?? []) {
    if (typeof exceptionValue.value === 'string') {
      exceptionValue.value = sanitizeProviderError(exceptionValue.value) ?? '[ERROR_REDACTED]';
    }
  }

  return event;
}

/**
 * Redact breadcrumb hoặc loại bỏ hẳn breadcrumb console.
 * @param breadcrumb Breadcrumb do Sentry SDK tạo.
 * @returns Breadcrumb đã scrub hoặc null để Sentry bỏ qua.
 */
export function redactSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category && DROPPED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) {
    return null;
  }

  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = sanitizeProviderLogMessage(breadcrumb.message);
  }

  if (breadcrumb.data) {
    const redactedData = redactSensitiveData(breadcrumb.data) ?? {};
    if (typeof redactedData.url === 'string') {
      redactedData.url = stripQueryString(redactedData.url);
    }
    breadcrumb.data = redactedData;
  }

  return breadcrumb;
}

/** Context tối thiểu mà tracesSampler cần, giúp test không phụ thuộc kiểu SDK cụ thể. */
export type TracesSamplingContext = {
  name?: string;
  parentSampled?: boolean;
};

/**
 * Quyết định tỉ lệ lấy mẫu transaction.
 * @param samplingContext Context transaction hiện tại.
 * @param configuredSampleRate Tỉ lệ production đã được validate.
 * @param nodeEnvironment Môi trường chạy Node.
 * @returns Tỉ lệ lấy mẫu từ 0 đến 1.
 */
export function resolveTracesSampleRate(
  samplingContext: TracesSamplingContext,
  configuredSampleRate: number,
  nodeEnvironment: string
): number {
  const transactionName = samplingContext.name ?? '';
  if (UNSAMPLED_TRANSACTION_PATTERNS.some(pattern => transactionName.includes(pattern))) {
    return 0;
  }

  // Quyết định của trace cha thắng để một distributed trace không bị cắt giữa chừng.
  if (samplingContext.parentSampled !== undefined) {
    return samplingContext.parentSampled ? 1 : 0;
  }

  if (nodeEnvironment !== 'production') return 1;
  return configuredSampleRate;
}
