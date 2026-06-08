import { Request, Response, NextFunction } from 'express';

type RateLimitState = {
  requestCount: number;
  resetAt: number;
};

type RateLimitOptions = {
  bucketName?: string;
};

const rateLimitStore = new Map<string, RateLimitState>();

/** Hàm tạo key cho rate limit. Mục đích: tách bucket theo endpoint/nhóm route để tránh chặn sai ngữ cảnh giữa các API khác nhau. */
function buildRateLimitKey(request: Request, bucketName?: string): string {
  const clientIpAddress = request.ip || 'unknown';
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
      response.status(429).json({
        success: false,
        message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.',
        errorCode: 'RATE_LIMIT_EXCEEDED',
        details: [],
        correlationId: null
      });
      return;
    }

    next();
  };
}

