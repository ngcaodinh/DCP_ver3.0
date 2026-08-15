import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';

type FallbackSlot = {
  expiresAtMilliseconds: number;
};

type FallbackCounter = {
  count: number;
  expiresAtMilliseconds: number;
};

const fallbackSlots = new Map<string, FallbackSlot>();
const fallbackCounters = new Map<string, FallbackCounter>();
/** Giới hạn số phần tử trong mỗi Map dự phòng để nhiều khóa không làm tăng bộ nhớ vô hạn. */
export const MAX_FALLBACK_ENTRIES = 10_000;
const logger = getLogger();
const FALLBACK_WARNING_INTERVAL_MILLISECONDS = 60_000;
let lastFallbackWarningAtMilliseconds: number | null = null;

/** Lỗi nội bộ báo store fallback đã đầy, để service chuyển thành HTTP 429 thay vì lỗi nghiệp vụ sai nghĩa. */
export class SubmissionThrottleCapacityError extends Error {
  constructor() {
    super('Submission throttle fallback capacity reached.');
    this.name = 'SubmissionThrottleCapacityError';
  }
}

/** Dọn các bản ghi dự phòng hết hạn để cơ chế chống trùng không làm phình bộ nhớ. */
function cleanupFallbackState(): void {
  const now = Date.now();
  for (const [key, slot] of fallbackSlots.entries()) {
    if (slot.expiresAtMilliseconds <= now) fallbackSlots.delete(key);
  }
  for (const [key, counter] of fallbackCounters.entries()) {
    if (counter.expiresAtMilliseconds <= now) fallbackCounters.delete(key);
  }
}

const cleanupTimer = setInterval(cleanupFallbackState, 60_000);
cleanupTimer.unref?.();

/** Giới hạn cảnh báo Redis fallback để sự cố hạ tầng không biến thành log flood. */
function warnRedisFallback(message: string): void {
  const now = Date.now();
  if (
    lastFallbackWarningAtMilliseconds !== null &&
    now - lastFallbackWarningAtMilliseconds < FALLBACK_WARNING_INTERVAL_MILLISECONDS
  ) {
    return;
  }
  lastFallbackWarningAtMilliseconds = now;
  logger.warn(message);
}

/** Chiếm một khóa độc quyền bằng Redis SET NX hoặc bộ nhớ dự phòng có giới hạn. */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      const result = await redisClient.set(key, '1', { NX: true, EX: ttlSeconds });
      return result === 'OK';
    } catch {
      warnRedisFallback('Redis unavailable for submission slot; using in-memory fallback.');
    }
  } else {
    warnRedisFallback('Redis unavailable for submission slot; using in-memory fallback.');
  }

  const now = Date.now();
  const existingSlot = fallbackSlots.get(key);
  if (existingSlot) {
    if (existingSlot.expiresAtMilliseconds > now) return false;
    // Chỉ kiểm tra hết hạn ở khóa đang được truy cập, tránh quét toàn Map trên đường xử lý nóng.
    fallbackSlots.delete(key);
  }
  if (fallbackSlots.size >= MAX_FALLBACK_ENTRIES) throw new SubmissionThrottleCapacityError();

  fallbackSlots.set(key, { expiresAtMilliseconds: now + ttlSeconds * 1000 });
  return true;
}

/** Giải phóng suất đã chiếm khi bước ghi feedback thất bại để người dùng có thể gửi lại. */
export async function releaseSubmissionSlot(key: string): Promise<void> {
  fallbackSlots.delete(key);
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return;

  try {
    await redisClient.del(key);
  } catch {
    logger.warn('Không thể giải phóng submission slot trên Redis.');
  }
}

/** Tăng bộ đếm giới hạn theo thao tác nguyên tử trên Redis hoặc bộ nhớ dự phòng có giới hạn. */
export async function countAgainstLimit(
  key: string,
  maximumCount: number,
  ttlSeconds: number
): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      const pipeline = redisClient.multi();
      pipeline.incr(key);
      pipeline.expire(key, ttlSeconds);
      const results = await pipeline.exec();
      const currentCount = Number((results as unknown[])[0]);
      return Number.isFinite(currentCount) && currentCount <= maximumCount;
    } catch {
      warnRedisFallback('Redis unavailable for daily feedback quota; using in-memory fallback.');
    }
  } else {
    warnRedisFallback('Redis unavailable for daily feedback quota; using in-memory fallback.');
  }

  const now = Date.now();
  const existingCounter = fallbackCounters.get(key);
  let nextCounter = 1;
  if (existingCounter) {
    if (existingCounter.expiresAtMilliseconds <= now) {
      // Chỉ kiểm tra hết hạn theo khóa đang truy cập để request mới không giữ lại hạn mức cũ.
      fallbackCounters.delete(key);
    } else {
      nextCounter = existingCounter.count + 1;
    }
  } else if (fallbackCounters.size >= MAX_FALLBACK_ENTRIES) {
    throw new SubmissionThrottleCapacityError();
  }
  fallbackCounters.set(key, {
    count: nextCounter,
    expiresAtMilliseconds: now + ttlSeconds * 1000
  });
  return nextCounter <= maximumCount;
}

/** Xóa trạng thái dự phòng giữa các kiểm thử đơn vị mà không ảnh hưởng tới luồng chạy thật. */
export function __resetSubmissionThrottleState(): void {
  fallbackSlots.clear();
  fallbackCounters.clear();
  lastFallbackWarningAtMilliseconds = null;
}
