/**
 * Scrub payload Sentry cho frontend, dùng chung cho client, server và edge runtime.
 * Mục đích: giữ cùng bất biến request telemetry với backend trước khi event rời ứng dụng.
 */

/** Header an toàn được phép tồn tại trong request telemetry của cả ba runtime. */
const ALLOWED_REQUEST_HEADERS = new Set([
  'content-type',
  'content-length',
  'accept',
  'x-request-id'
]);

/** Khóa dữ liệu nhạy cảm trong breadcrumb sau khi chuẩn hóa casing và ký tự phân cách. */
const SENSITIVE_DATA_KEYS = new Set([
  'token',
  'accesstoken',
  'idtoken',
  'code',
  'nonce',
  'session',
  'sessionid',
  'signature',
  'authorization',
  'cookie',
  'apikey',
  'proxyauthorization',
  'password',
  'secret',
  'secretkey',
  'bearertoken',
  'privatekey',
  'walletaddress',
  'ipaddress',
  'email',
  'bankaccount',
  'phonenumber',
  'body',
  'devicefingerprinthash',
  'clientip',
  'sourceip',
  'useragent',
  'error',
  'errormessage',
  'originalerror',
  'providererrormessage',
  'reason',
  'stack',
  'errorstack',
  'ip',
  'gps',
  'gpscoordinates',
  'latitude',
  'longitude',
  'smartaccountaddress',
  'guestwalletaddress',
  'donoraddress',
  'beneficiaryaddress',
  'toaddress',
  'claimeoaddress',
  'fallbackwalletaddress',
  'sender',
  'operator',
  'amount',
  'amountvnd',
  'donationamount',
  'totalamount',
  'transferamount'
]);

/** Trường breadcrumb có thể chứa URL và phải cắt cả query lẫn fragment. */
const URL_DATA_KEYS = new Set(['url', 'href', 'from', 'to', 'referrer', 'referer']);
const MAX_BREADCRUMB_DATA_DEPTH = 6;
const PROVIDER_ERROR_MAX_LENGTH = 240;
const REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_DATA_MARKER = '[CIRCULAR_REDACTED]';
const NON_PLAIN_DATA_MARKER = '[NON_PLAIN_DATA_REDACTED]';

/** Cắt query và fragment để URL telemetry không mang token, mã claim hoặc PII. */
export function scrubUrl(rawUrl: string): string {
  const separatorIndex = rawUrl.search(/[?#]/);
  return separatorIndex === -1 ? rawUrl : rawUrl.slice(0, separatorIndex);
}

interface ScrubbableSentryRequest {
  url?: string;
  method?: string;
  cookies?: unknown;
  data?: unknown;
  query_string?: unknown;
  headers?: Record<string, string>;
}

interface ScrubbableSentryBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

interface ScrubbableSentryEvent {
  message?: string;
  extra?: Record<string, unknown>;
  user?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: unknown;
    }>;
  };
  request?: ScrubbableSentryRequest;
  breadcrumbs?: ScrubbableSentryBreadcrumb[];
}

/** Chuẩn hóa key để nhận diện cả header và trường dữ liệu nhạy cảm. */
function normalizeDataKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Che token, PII và URL provider trong text telemetry nhưng giữ lại ngữ cảnh debug an toàn. */
function sanitizeSentryMessage(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|authorization|key|password|secret|token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(["']?)(api[-_]?key|access[-_]?token|authorization|password|private[-_]?key|secret(?:[-_]?key)?|token)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;}\s]+)/gi, '$1$2$1:"[REDACTED]"')
    .replace(/\b(api[-_]?key|access[-_]?token|authorization|password|private[-_]?key|secret(?:[-_]?key)?|token)\s*[:=]\s*[^\s,;}&]+/gi, '$1=[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/\b0x[a-f0-9]{40,64}\b/gi, '0x[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP_REDACTED]')
    .replace(/-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/g, '[GPS_REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED_VALUE)
    .replace(/(?:\d[\s-]?){5,}\d/g, REDACTED_VALUE)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Giới hạn độ dài exception sau khi che dữ liệu nhạy cảm để event không mang provider payload quá lớn. */
function sanitizeSentryExceptionMessage(value: string): string {
  return sanitizeSentryMessage(value).slice(0, PROVIDER_ERROR_MAX_LENGTH) || '[ERROR_REDACTED]';
}

/** Xác định object thuần để chỉ duyệt metadata do ứng dụng gắn, không serialize object SDK hoặc browser. */
function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Scrub đệ quy metadata trong giới hạn để tránh payload bất định. */
function redactBreadcrumbValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth >= MAX_BREADCRUMB_DATA_DEPTH) return '[NESTED_DATA_REDACTED]';
  if (value instanceof Error) return sanitizeSentryExceptionMessage(value.message);

  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR_DATA_MARKER;
    ancestors.add(value);
    try {
      return value.map(item => redactBreadcrumbValue(item, depth + 1, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }

  if (value && typeof value === 'object') {
    if (!isPlainRecord(value)) return NON_PLAIN_DATA_MARKER;
    if (ancestors.has(value)) return CIRCULAR_DATA_MARKER;

    ancestors.add(value);
    const redactedValue: Record<string, unknown> = {};
    try {
      for (const [key, nestedValue] of Object.entries(value)) {
        const normalizedKey = normalizeDataKey(key);
        if (SENSITIVE_DATA_KEYS.has(normalizedKey)) {
          redactedValue[key] = REDACTED_VALUE;
        } else if (URL_DATA_KEYS.has(normalizedKey) && typeof nestedValue === 'string') {
          redactedValue[key] = scrubUrl(nestedValue);
        } else {
          redactedValue[key] = redactBreadcrumbValue(nestedValue, depth + 1, ancestors);
        }
      }
      return redactedValue;
    } finally {
      ancestors.delete(value);
    }
  }

  return value;
}

/** Tạo bản sao metadata đã redact mà không làm thay đổi object dữ liệu SDK đang quản lý. */
function redactSentryMetadata(data: Record<string, unknown>): Record<string, unknown> {
  return redactBreadcrumbValue(data, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/** Redact context ứng dụng nhưng giữ nguyên trace để distributed tracing không bị đứt. */
function redactSentryContexts(contexts: Record<string, unknown>): Record<string, unknown> {
  const { trace, ...customContexts } = contexts;
  const redactedContexts = redactSentryMetadata(customContexts);
  return trace === undefined ? redactedContexts : { ...redactedContexts, trace };
}

/** Chỉ giữ header không nhạy cảm và loại bỏ header từ proxy hoặc ứng dụng tự định nghĩa. */
function filterAllowedRequestHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const filteredHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(headerName.toLowerCase())) {
      filteredHeaders[headerName] = headerValue;
    }
  }
  return filteredHeaders;
}

/**
 * Scrub message và data của breadcrumb trước khi breadcrumb được lưu vào event.
 * @param breadcrumb Breadcrumb do Sentry SDK tạo.
 * @returns Breadcrumb đã scrub hoặc null nếu breadcrumb cần bị loại bỏ.
 */
export function scrubSentryBreadcrumb<T extends ScrubbableSentryBreadcrumb>(breadcrumb: T): T | null {
  if (breadcrumb.category === 'console') return null;
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = sanitizeSentryMessage(breadcrumb.message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = redactSentryMetadata(breadcrumb.data);
  }
  return breadcrumb;
}

/**
 * Redact metadata/message/exception, sau đó loại bỏ dữ liệu request không cần thiết và breadcrumb đã bị loại bỏ.
 * @param event Event Sentry cần scrub.
 * @returns Chính event đã scrub theo contract beforeSend.
 */
export function scrubSentryEvent<T extends ScrubbableSentryEvent>(event: T): T {
  if (event.extra) {
    event.extra = redactSentryMetadata(event.extra);
  }
  if (event.user) {
    event.user = redactSentryMetadata(event.user);
  }
  if (event.tags) {
    event.tags = redactSentryMetadata(event.tags);
  }
  if (event.contexts) {
    event.contexts = redactSentryContexts(event.contexts);
  }
  if (typeof event.message === 'string') {
    event.message = sanitizeSentryMessage(event.message);
  }
  for (const exceptionValue of event.exception?.values ?? []) {
    if (typeof exceptionValue.value === 'string') {
      exceptionValue.value = sanitizeSentryExceptionMessage(exceptionValue.value);
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap(breadcrumb => {
      const scrubbedBreadcrumb = scrubSentryBreadcrumb(breadcrumb);
      return scrubbedBreadcrumb ? [scrubbedBreadcrumb] : [];
    });
  }

  if (!event.request) return event;

  event.request = {
    url: typeof event.request.url === 'string' ? scrubUrl(event.request.url) : undefined,
    method: event.request.method,
    headers: event.request.headers
      ? filterAllowedRequestHeaders(event.request.headers)
      : undefined
  };

  return event;
}
