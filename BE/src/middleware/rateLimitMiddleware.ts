import { Request, Response, NextFunction } from 'express';
import { sendErrorResponse } from '../utils/apiResponse';

type RateLimitState = {
  requestCount: number;
  resetAt: number;
};

type RateLimitOptions = {
  bucketName?: string;
};

// Lưu ý: In-memory Map sẽ bị reset khi server restart.
// Multi-instance: mỗi instance có rate limit riêng.
// Giải pháp Redis (ioredis + lua script) cho production đã có trong backlog.
const rateLimitStore = new Map<string, RateLimitState>();

// [I-A2] Cleanup stale entries định kỳ để tránh memory leak.
// Mỗi entry tồn tại tối đa timeWindowInMs + 1 cycle. Với cycle 60s, mỗi IP tốn ~60 bytes.
// Periodic cleanup giới hạn memory growth về O(unique_ips_per_window).
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of rateLimitStore.entries()) {
    if (state.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

/**
 * Hàm tạo key cho rate limit. Mục đích: tách bucket theo endpoint/nhóm route để tránh chặn sai ngữ cảnh giữa các API khác nhau.
 *
 * [I-A6] Trust proxy: hiện tại chỉ có 1 proxy (Nginx) đứng trước backend.
 * Nếu thêm proxy trong tương lai, cần update comment này và count trong x-forwarded-for parsing.
 */
function buildRateLimitKey(request: Request, bucketName?: string): string {
  // Nếu đặt behind proxy (Nginx), phải bật TRUST_PROXY=true và đảm bảo chỉ có 1 proxy
  // Current: 1 proxy (Nginx) → trust proxy count = 1
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const clientIpAddress = trustProxy ? (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip : request.ip || 'unknown';
  const normalizedBucketName = bucketName || `${request.method}:${request.baseUrl}${request.path}`;
  return `${normalizedBucketName}:${clientIpAddress}`;
}

/** Hàm tạo middleware rate limit. Mục đích: giới hạn số lần gọi API theo từng bucket thay vì gộp toàn bộ theo IP. */
export function createRateLimitMiddleware(maxRequests: number, timeWindowInMs: number, options?: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const rateLimitKey = buildRateLimitKey(request, options?.bucketName);
    const currentTimestamp = Date.now();
    const existingState = rateLimitStore.get(rateLimitKey);

    if (!existingState || existingState.resetAt <= currentTimestamp) {
      rateLimitStore.set(rateLimitKey, {
        requestCount: 1,
        resetAt: currentTimestamp + timeWindowInMs
      });
      next();
      return;
    }

    const updatedCount = existingState.requestCount + 1;
    rateLimitStore.set(rateLimitKey, {
      requestCount: updatedCount,
      resetAt: existingState.resetAt
    });

    if (updatedCount > maxRequests) {
      // [N-B3] Dùng sendErrorResponse cho 429 response nhất quán với các endpoint khác
      sendErrorResponse(
        response,
        429,
        'Bạn thao tác quá nhanh. Vui lòng thử lại sau.',
        'RATE_LIMIT_EXCEEDED'
      );
      return;
    }

    next();
  };
}

