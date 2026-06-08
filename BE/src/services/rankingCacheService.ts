import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';

const logger = getLogger();
const rankingFallbackCache = createInMemoryCache<string>();
const rankingCachePrefix = 'ranking:get:';
const rankingCacheTimeToLiveSeconds = 30;

/** Hàm tạo cache key cho API GET /rankings. Mục đích: đồng bộ key giữa đọc cache và invalidate cache. */
export function buildRankingCacheKey(queryString: string): string {
  return `${rankingCachePrefix}${queryString || 'default'}`;
}

/**
 * Hàm extract message từ error object.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message ?? (error as Record<string, unknown>).errorMessage;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

/** Hàm lấy dữ liệu ranking từ cache. Mục đích: giảm tải truy vấn DB cho endpoint đọc bảng xếp hạng. */
export async function getRankingResponseCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      return await redisClient.get(cacheKey);
    } catch (error) {
      logger.warn('Redis get ranking cache failed.', { errorMessage: extractErrorMessage(error) });
    }
  }

  return rankingFallbackCache.get(cacheKey);
}

/** Hàm lưu dữ liệu ranking vào cache. Mục đích: dùng lại response GET /rankings trong khoảng TTL ngắn. */
export async function setRankingResponseCache(cacheKey: string, responsePayloadJson: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, responsePayloadJson, { EX: rankingCacheTimeToLiveSeconds });
      return;
    } catch (error) {
      logger.warn('Redis set ranking cache failed.', { errorMessage: extractErrorMessage(error) });
    }
  }

  rankingFallbackCache.set(cacheKey, responsePayloadJson, rankingCacheTimeToLiveSeconds);
}

/** Hàm xóa cache ranking. Mục đích: đảm bảo GET /rankings nhận snapshot mới ngay sau recalculate. */
export async function invalidateRankingCache(): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      const cacheKeyList = await redisClient.keys(`${rankingCachePrefix}*`);
      if (cacheKeyList.length > 0) {
        await redisClient.del(cacheKeyList);
      }
    } catch (error) {
      logger.warn('Redis invalidate ranking cache failed.', { errorMessage: extractErrorMessage(error) });
    }
  }

  // Luôn xóa in-memory cache bất kể Redis có hoạt động hay không.
  // Tránh trường hợp Redis xóa thành công nhưng in-memory cache vẫn giữ dữ liệu cũ
  // (user refresh → Redis miss → fallback vào in-memory → trả dữ liệu cũ).
  rankingFallbackCache.clearAll();
}
