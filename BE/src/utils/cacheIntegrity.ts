import crypto from 'crypto';

const CACHE_HMAC_KEY_MIN_LENGTH = 32;

/** Kiểm tra độ dài khóa HMAC khi chạy production để tránh cấu hình secret yếu. */
function validateProductionKey(key: string, keyName: string): string {
  if (process.env.NODE_ENV === 'production' && key.length < CACHE_HMAC_KEY_MIN_LENGTH) {
    throw new Error(`${keyName} must be at least ${CACHE_HMAC_KEY_MIN_LENGTH} characters in production.`);
  }
  return key;
}

/** Tạo input ổn định để chữ ký bị ràng buộc với đúng namespace/cache key. */
function buildSigningInput(payload: string, cacheKey: string): string {
  return `${cacheKey.length}:${cacheKey}:${payload}`;
}

/**
 * Lấy khóa HMAC dùng để bảo vệ toàn vẹn payload cache.
 * Ưu tiên secret cấu hình riêng, sau đó dùng JWT secret để tương thích triển khai cũ.
 */
export function getCacheHmacKey(): string {
  const configuredCacheKey = String(process.env.CACHE_HMAC_KEY || '').trim();
  if (configuredCacheKey) return validateProductionKey(configuredCacheKey, 'CACHE_HMAC_KEY');

  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  if (jwtSecret) return validateProductionKey(jwtSecret, 'JWT_SECRET fallback');

  // Không dùng secret cố định trong production: nếu thiếu cấu hình thì fail-closed
  // thay vì tạo chữ ký mà bất kỳ ai cũng có thể tự tạo lại.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CACHE_HMAC_KEY (or JWT_SECRET fallback) is not configured in production.');
  }

  return 'dcp-cache-hmac-default-rotate-me';
}

/**
 * Ký payload cache bằng HMAC-SHA256.
 * @param payload Chuỗi JSON cần ký
 * @param cacheKey Key cache mà payload được phép nằm dưới
 * @returns Payload gốc kèm chữ ký hex, ngăn cách bằng dấu chấm
 */
export function signCachePayload(payload: string, cacheKey: string): string {
  const signature = crypto.createHmac('sha256', getCacheHmacKey())
    .update(buildSigningInput(payload, cacheKey))
    .digest('hex');
  return `${payload}.${signature}`;
}

/**
 * Xác minh chữ ký cache bằng so sánh constant-time.
 * @param signedPayload Payload đã ký cần kiểm tra
 * @param cacheKey Key cache mà payload phải được ràng buộc vào
 * @returns Payload gốc nếu hợp lệ, null nếu chữ ký thiếu hoặc không đúng
 */
export function verifyCachePayload(signedPayload: string, cacheKey: string): string | null {
  const separatorIndex = signedPayload.lastIndexOf('.');
  if (separatorIndex === -1) return null;

  const payload = signedPayload.slice(0, separatorIndex);
  const providedSignature = signedPayload.slice(separatorIndex + 1);
  if (!payload || !providedSignature) return null;

  const expectedSignature = crypto.createHmac('sha256', getCacheHmacKey())
    .update(buildSigningInput(payload, cacheKey))
    .digest('hex');
  const providedBuffer = Buffer.from(providedSignature, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  return payload;
}
