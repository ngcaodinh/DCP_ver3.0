const PROVIDER_ERROR_MAX_LENGTH = 240;

/** Kiểm tra value có phải object key-value để sanitize đệ quy hay không. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Che dữ liệu nhạy cảm trong message dạng text, kể cả key có quote kiểu JSON chưa parse được. */
function maskProviderErrorText(errorMessage: string): string {
  return errorMessage
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|authorization|key|password|secret|token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/\b0x[a-f0-9]{40}\b/gi, '0x[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
    .replace(
      /((?:["']?)(?:to)?(?:account|bank|recipient|holder|phone|mobile|name)[A-Za-z0-9_-]*(?:["']?\s*[:=]\s*))("[^"]*"|'[^']*'|[^,;|}\n]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/(?:\d[\s-]?){5,}\d/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sanitize object/string lồng nhau để provider payload không bypass bằng field JSON lồng. */
function sanitizeProviderValue(value: unknown, depth: number = 0): unknown {
  if (depth > 4) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeProviderValue(item, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
      if (
        /(account|bank|recipient|holder|phone|mobile|name)/i.test(key)
        || ['accesstoken', 'apikey', 'authorization', 'password', 'secret', 'token']
          .includes(normalizedKey)
      ) {
        return [key, '[REDACTED]'];
      }
      return [key, sanitizeProviderValue(nestedValue, depth + 1)];
    }));
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim();
    if (depth < 4 && (trimmedValue.startsWith('{') || trimmedValue.startsWith('['))) {
      try {
        return sanitizeProviderValue(JSON.parse(trimmedValue) as unknown, depth + 1);
      } catch {
        // Giữ dạng text và áp dụng mask regex ở bước dưới khi provider trả JSON lỗi.
      }
    }
    return maskProviderErrorText(value);
  }

  return value;
}

/**
 * Làm sạch lỗi từ provider trước khi lưu, log hoặc trả về client để tránh lộ PII.
 * @param errorMessage Message, Error hoặc payload lỗi bất kỳ từ provider.
 * @returns Chuỗi lỗi đã giới hạn độ dài và loại bỏ dữ liệu nhạy cảm.
 */
export function sanitizeProviderError(errorMessage: unknown): string | null {
  if (!errorMessage) {
    return null;
  }

  const rawValue = errorMessage instanceof Error
    ? errorMessage.message
    : errorMessage;
  const sanitizedValue = sanitizeProviderValue(rawValue);
  const serializedValue = typeof sanitizedValue === 'string'
    ? sanitizedValue
    : JSON.stringify(sanitizedValue);
  const sanitizedMessage = maskProviderErrorText(serializedValue || String(sanitizedValue))
    .slice(0, PROVIDER_ERROR_MAX_LENGTH);

  return sanitizedMessage || null;
}
