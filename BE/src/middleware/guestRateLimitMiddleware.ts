/**
 * Hybrid Rate Limit cho guest endpoints — 2 lớp bảo vệ:
 *
 * Lớp 1 (In-Memory): Chống DDoS/flooding. Mỗi IP bị giới hạn 20 req/10s.
 * Dùng token bucket đơn giản trong Map RAM. Reject ngay không tốn Redis I/O.
 *
 * Lớp 2 (Redis): Lọc tinh nghiệp vụ trên multi-instance.
 * - guestSessionRateLimit: 5 sessions/IP/hour cho POST /api/guest/session
 * - guestDonationRateLimit: 3 sponsor requests/session cho /api/guest/paymaster/sponsor
 *
 * Không crash khi Redis unavailable — fallback sang Lớp 1 + warning log.
 */
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getRedisClientIfReady } from '../config/redis';
import { getLogger } from '../config/logger';
import { sendErrorResponse } from '../utils/apiResponse';

const logger = getLogger();

/**
 * Token bucket state cho lớp 1 (in-memory anti-DDoS).
 * Key = IP address, value = { tokens, lastRefillTimestamp }
 */
type InMemoryBucket = {
  tokens: number;
  lastRefill: number;
};

const inMemoryBuckets = new Map<string, InMemoryBucket>();

/** Ngưỡng Lớp 1: 20 requests / 10 giây / IP */
const LAYER1_MAX_TOKENS = 20;
const LAYER1_REFILL_RATE = 2; // tokens per second

/** Giới hạn tối đa số entries trong inMemoryBuckets — ngăn Map phình quá lớn khi bị DDoS. */
const LAYER1_MAX_ENTRIES = 50_000;

/**
 * Hàm refill token bucket theo thời gian.
 * Mục đích: mô phỏng token bucket — mỗi giây được thêm 2 tokens, max 20.
 */
function refillBucket(bucket: InMemoryBucket, now: number): InMemoryBucket {
  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  const newTokens = Math.min(
    LAYER1_MAX_TOKENS,
    bucket.tokens + elapsedSeconds * LAYER1_REFILL_RATE
  );
  return {
    tokens: Math.floor(newTokens),
    lastRefill: now
  };
}

/**
 * Hàm kiểm tra Lớp 1 (in-memory anti-DDoS).
 * Reject ngay nếu vượt ngưỡng flood — không tốn Redis lookup.
 *
 * Lưu ý: Chỉ tin tưởng request.ip đã được proxy trả về qua trust proxy.
 * Không dùng x-forwarded-for vì attacker có thể spoof header này.
 * app.ts cấu hình trust proxy bằng: app.set('trust proxy', 1).
 */
function checkLayer1RateLimit(clientIp: string): { allowed: boolean; bucket: InMemoryBucket } {
  const now = Date.now();
  const existingBucket = inMemoryBuckets.get(clientIp);

  if (!existingBucket) {
    // Nếu Map đã đầy (quá giới hạn entries) — reject thay vì thêm entry mới.
    // Đây là defensive measure chống lại memory exhaustion attack.
    if (inMemoryBuckets.size >= LAYER1_MAX_ENTRIES) {
      return {
        allowed: false,
        bucket: { tokens: 0, lastRefill: now }
      };
    }
    const newBucket: InMemoryBucket = { tokens: LAYER1_MAX_TOKENS - 1, lastRefill: now };
    inMemoryBuckets.set(clientIp, newBucket);
    return { allowed: true, bucket: newBucket };
  }

  const refilledBucket = refillBucket(existingBucket, now);

  if (refilledBucket.tokens <= 0) {
    inMemoryBuckets.set(clientIp, refilledBucket);
    return { allowed: false, bucket: refilledBucket };
  }

  const consumedBucket: InMemoryBucket = {
    tokens: refilledBucket.tokens - 1,
    lastRefill: now
  };
  inMemoryBuckets.set(clientIp, consumedBucket);
  return { allowed: true, bucket: consumedBucket };
}

/**
 * Hàm xóa các bucket đã stale (không hoạt động quá 60 giây).
 * Chạy định kỳ để tránh memory leak khi client ngắt kết nối.
 * Singleton guard đảm bảo chỉ có một interval tồn tại — ngăn leak khi hot-reload.
 */
let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;

function cleanupStaleBuckets(): void {
  const now = Date.now();
  const staleThreshold = 60_000;
  for (const [ip, bucket] of inMemoryBuckets.entries()) {
    if (now - bucket.lastRefill > staleThreshold) {
      inMemoryBuckets.delete(ip);
    }
  }
}

/**
 * Singleton cleanup scheduler — chỉ đăng ký interval một lần duy nhất.
 * Mục đích: ngăn memory leak khi module được re-import (ts-node-dev hot reload).
 */
function ensureCleanupScheduler(): void {
  if (cleanupIntervalHandle === null) {
    cleanupIntervalHandle = setInterval(cleanupStaleBuckets, 60_000);
  }
}

/**
 * Hàm dọn dẹp singleton cleanup scheduler.
 * Export để server shutdown handler có thể gọi khi tắt ứng dụng.
 */
export function stopCleanupScheduler(): void {
  if (cleanupIntervalHandle !== null) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }
}

// Đăng ký cleanup scheduler ngay khi module được import
ensureCleanupScheduler();

/**
 * Hàm trích xuất IP client an toàn.
 * Chỉ dùng request.ip vì app.ts đã cấu hình trust proxy.
 * Không tin x-forwarded-for vì attacker có thể spoof.
 */
function getClientIp(request: Request): string {
  return request.ip || 'unknown';
}

/**
 * Hàm tạo middleware rate limit Lớp 1 cho tất cả guest endpoints.
 * Mục đích: chặn flood ngay từ đầu mà không cần Redis.
 */
export function createGuestLayer1RateLimitMiddleware() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const clientIp = getClientIp(request);
    const { allowed } = checkLayer1RateLimit(clientIp);

    if (!allowed) {
      sendErrorResponse(
        response,
        429,
        'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
        'GUEST_RATE_LIMIT_EXCEEDED'
      );
      return;
    }

    next();
  };
}

/**
 * Hàm kiểm tra Lớp 2 (Redis) cho guest session creation.
 * Giới hạn: 5 sessions/IP/hour (sliding window).
 * Dùng Redis pipeline để giảm round-trip từ 3 lần xuống 1 lần.
 *
 * Bug fix: Dùng unique value cho zAdd (nano ID) để tránh race condition.
 * Nếu 2 requests cùng IP đến trong cùng 1 millisecond, timestamp làm value
 * sẽ trùng nhau → Redis ghi đè member thay vì thêm mới → zCard đếm thiếu
 * → bypass rate limit.
 *
 * Giải pháp: Tạo value = `${timestamp}-${nanoid}` đảm bảo unique tuyệt đối.
 * Rollback dùng zRem(member) chính xác thay vì zRemRangeByScore (xóa nhầm
 * member cùng timestamp từ user khác).
 */
async function checkGuestSessionRedisLimit(clientIp: string): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis unavailable, skipping Lớp 2 rate limit check.');
    return true;
  }

  const redisKey = `guest:rate:session:${clientIp}`;
  const now = Date.now();
  const windowStart = now - 3_600_000; // 1 giờ

  // Tạo unique member — dùng timestamp + UUID để đảm bảo unique tuyệt đối.
  // randomUUID() từ crypto module đảm bảo entropy cao, không đoán được.
  const memberValue = `${now}-${now % 1000}-${randomUUID()}`;

  try {
    // Pipeline: zRemRangeByScore + zCard + zAdd + expire trong 1 round-trip
    const pipeline = redisClient.multi();
    pipeline.zRemRangeByScore(redisKey, '0', windowStart.toString());
    pipeline.zCard(redisKey);
    pipeline.zAdd(redisKey, { score: now, value: memberValue });
    pipeline.expire(redisKey, 3600);
    const results = await pipeline.exec();

    // results[1] = zCard result. Cast through unknown vì Redis pipeline reply type
    // là union type, TypeScript không biết chính xác type của từng element.
    const replies = results as unknown[];
    const currentCount = replies[1] as number;

    if (currentCount >= 5) {
      // Rollback: xóa chính xác member vừa thêm bằng zRem.
      // Dùng zRem(member) thay vì zRemRangeByScore để tránh xóa nhầm
      // member từ user khác có cùng timestamp.
      await redisClient.zRem(redisKey, memberValue);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('[checkGuestSessionRedisLimit] Redis rate limit check failed, bypassing layer 2.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      context: { clientIp }
    });
    return true;
  }
}

/**
 * Hàm kiểm tra Lớp 2 (Redis) cho donation sponsorship.
 * Giới hạn: 3 sponsor requests/session.
 */
async function checkGuestDonationRedisLimit(sessionId: string): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis unavailable, skipping donation rate limit check.');
    return true;
  }

  const redisKey = `guest:rate:donation:${sessionId}`;

  try {
    // Dùng pipeline để INCR và EXPIRE atomic trong cùng 1 round-trip.
    // Tránh race condition: nếu server crash giữa INCR và EXPIRE,
    // key sẽ không bao giờ expire → session bị block vĩnh viễn.
    const pipeline = redisClient.multi();
    pipeline.incr(redisKey);
    pipeline.expire(redisKey, 3600);
    const results = await pipeline.exec();
    const currentCount = (results as unknown[])[0] as number;

    return currentCount <= 3;
  } catch (error) {
    logger.error('[checkGuestDonationRedisLimit] Redis donation rate limit check failed, bypassing layer 2.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      context: { sessionId }
    });
    return true;
  }
}

/**
 * Hàm tạo middleware rate limit Lớp 2 cho session creation.
 * Áp dụng sau Lớp 1 — chỉ chạy khi Lớp 1 đã pass.
 */
export function createGuestSessionRateLimitMiddleware() {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const clientIp = getClientIp(request);

    const allowed = await checkGuestSessionRedisLimit(clientIp);
    if (!allowed) {
      sendErrorResponse(
        response,
        429,
        'Bạn đã tạo quá nhiều phiên guest. Vui lòng thử lại sau 1 giờ.',
        'GUEST_SESSION_RATE_LIMIT_EXCEEDED'
      );
      return;
    }

    next();
  };
}

/**
 * Hàm tạo middleware rate limit Lớp 2 cho donation sponsorship.
 * Áp dụng sau guestAuthMiddleware — dùng sessionId từ request.
 */
export function createGuestDonationRateLimitMiddleware() {
  return async (
    request: Request & { guestSession?: { sessionId: string } },
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    const sessionId = request.guestSession?.sessionId;
    if (!sessionId) {
      sendErrorResponse(response, 401, 'Vui lòng xác thực guest session trước.', 'GUEST_SESSION_REQUIRED');
      return;
    }

    const allowed = await checkGuestDonationRedisLimit(sessionId);
    if (!allowed) {
      sendErrorResponse(
        response,
        429,
        'Bạn đã gửi quá nhiều yêu cầu tài trợ gas. Vui lòng thử lại sau.',
        'GUEST_DONATION_RATE_LIMIT_EXCEEDED'
      );
      return;
    }

    next();
  };
}
