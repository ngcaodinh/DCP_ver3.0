import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';

const logger = getLogger();

/** Cache in-memory fallback khi Redis không khả dụng. */
const trustScoreFallbackCache = createInMemoryCache<string>();

/** Prefix cho tất cả Redis keys của trust score. */
const TRUST_SCORE_CACHE_PREFIX = 'trust:donor:';

/** TTL cache trust score: 1 giờ (3600 giây). */
const TRUST_SCORE_CACHE_TTL_SECONDS = 3600;

/**
 * Hàm xây dựng cache key cho trust score của một donor.
 * Mục đích: đảm bảo key nhất quán giữa set, get và invalidate.
 *
 * @param donorAddress - Wallet address của donor (đã lowercase).
 * @returns Cache key theo định dạng trust:donor:{address}.
 */
export function buildTrustScoreCacheKey(donorAddress: string): string {
  return `${TRUST_SCORE_CACHE_PREFIX}${donorAddress.toLowerCase()}`;
}

/**
 * Hàm extract error message an toàn từ unknown error.
 * Mục đích: tránh lặp boilerplate ép kiểu error trong catch blocks.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = (error as Record<string, unknown>).message;
    if (typeof candidate === 'string') return candidate;
  }
  return String(error);
}

/**
 * Hàm lấy dữ liệu trust score từ cache (Redis → in-memory fallback).
 * Mục đích: giảm tải truy vấn DB cho các request đọc trust score thường xuyên.
 *
 * @param donorAddress - Wallet address của donor.
 * @returns Chuỗi JSON của trust score record hoặc null nếu cache miss.
 */
export async function getTrustScoreCache(donorAddress: string): Promise<string | null> {
  const cacheKey = buildTrustScoreCacheKey(donorAddress);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      return await redisClient.get(cacheKey);
    } catch (error) {
      logger.warn('Redis get trust score cache thất bại — dùng in-memory fallback.', {
        donorAddress,
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  return trustScoreFallbackCache.get(cacheKey);
}

/**
 * Hàm lưu dữ liệu trust score vào cache.
 * Mục đích: cache kết quả tính trust score để tránh recalculate cho mỗi request trong vòng TTL.
 *
 * Chiến lược: Redis primary (TTL 3600s), in-memory fallback nếu Redis không khả dụng.
 * Khi Redis thành công → không write vào in-memory để tránh dual-state inconsistency.
 *
 * @param donorAddress - Wallet address của donor.
 * @param payload - Chuỗi JSON của trust score record.
 */
export async function setTrustScoreCache(donorAddress: string, payload: string): Promise<void> {
  const cacheKey = buildTrustScoreCacheKey(donorAddress);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, payload, { EX: TRUST_SCORE_CACHE_TTL_SECONDS });
      return;
    } catch (error) {
      logger.warn('Redis set trust score cache thất bại — fallback vào in-memory.', {
        donorAddress,
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  trustScoreFallbackCache.set(cacheKey, payload, TRUST_SCORE_CACHE_TTL_SECONDS);
}

/**
 * Hàm xóa cache trust score của một donor cụ thể.
 * Mục đích: invalidate cache ngay sau khi recalculate để đảm bảo response tiếp theo trả dữ liệu mới.
 *
 * @param donorAddress - Wallet address của donor.
 */
export async function invalidateTrustScoreCache(donorAddress: string): Promise<void> {
  const cacheKey = buildTrustScoreCacheKey(donorAddress);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.del(cacheKey);
    } catch (error) {
      logger.warn('Redis del trust score cache thất bại.', {
        donorAddress,
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  // Luôn xóa in-memory cache bất kể Redis có thành công hay không.
  // Tránh trường hợp Redis xóa xong nhưng in-memory vẫn giữ dữ liệu cũ → stale read.
  trustScoreFallbackCache.deleteByKey(cacheKey);
}

/**
 * Hàm xóa toàn bộ cache trust score của tất cả donors.
 * Mục đích: bulk invalidation sau khi daily scheduler recalculate toàn bộ.
 *
 * Dùng SCAN thay vì KEYS để không block Redis event loop trên production lớn.
 * KEYS là O(N) blocking — với hàng nghìn keys sẽ gây latency spike cho toàn bộ Redis.
 * SCAN chia nhỏ iteration thành nhiều lần, mỗi lần xử lý một batch nhỏ (cursor-based).
 */
export async function invalidateAllTrustScoreCaches(): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      // SCAN cursor-based với scanIterator: duyệt toàn bộ keyset không block Redis event loop.
      // Dùng scanIterator thay vì KEYS để tránh O(N) blocking trên production lớn.
      for await (const keys of redisClient.scanIterator({
        MATCH: `${TRUST_SCORE_CACHE_PREFIX}*`,
        COUNT: 100
      })) {
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      }
    } catch (error) {
      logger.warn('Redis invalidate all trust score caches thất bại.', {
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  // Luôn clear in-memory cache toàn bộ sau bulk invalidation
  trustScoreFallbackCache.clearAll();
}
