import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const logger = getLogger();
const sbtFallbackCache = createInMemoryCache<string>();
const SBT_CACHE_KEY_PREFIX = 'sbt:token:';
const SBT_NOT_FOUND_CACHE_KEY_PREFIX = 'sbt:token:not-found:';
export const SBT_METADATA_CACHE_TTL_SECONDS = 3_600;
export const SBT_NOT_FOUND_CACHE_TTL_SECONDS = 60;

/** Tạo cache key ổn định cho metadata detail theo tokenId on-chain. */
export function buildSbtTokenCacheKey(tokenId: number): string {
  return `${SBT_CACHE_KEY_PREFIX}${tokenId}`;
}

/** Tạo cache key riêng cho marker SBT không tồn tại để không trộn với detail hợp lệ. */
function buildSbtTokenNotFoundCacheKey(tokenId: number): string {
  return `${SBT_NOT_FOUND_CACHE_KEY_PREFIX}${tokenId}`;
}

/** Đọc metadata SBT từ Redis, fallback in-memory khi Redis chưa sẵn sàng hoặc lỗi. */
export async function getSbtTokenCache(tokenId: number): Promise<string | null> {
  const cacheKey = buildSbtTokenCacheKey(tokenId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      return await redisClient.get(cacheKey);
    } catch (error) {
      logger.warn('Redis get SBT metadata cache thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  return sbtFallbackCache.get(cacheKey);
}

/** Kiểm tra marker NOT_FOUND ngắn hạn trước khi phát sinh thêm RPC cho token không tồn tại. */
export async function getSbtTokenNotFoundCache(tokenId: number): Promise<boolean> {
  const cacheKey = buildSbtTokenNotFoundCacheKey(tokenId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      return (await redisClient.get(cacheKey)) === '1';
    } catch (error) {
      logger.warn('Redis get negative cache SBT thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  return sbtFallbackCache.get(cacheKey) === '1';
}

/** Ghi metadata SBT vào cache với TTL một giờ để giảm RPC/IPFS request trên detail endpoint. */
export async function setSbtTokenCache(tokenId: number, payloadJson: string): Promise<void> {
  const cacheKey = buildSbtTokenCacheKey(tokenId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, payloadJson, { EX: SBT_METADATA_CACHE_TTL_SECONDS });
      return;
    } catch (error) {
      logger.warn('Redis set SBT metadata cache thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  sbtFallbackCache.set(cacheKey, payloadJson, SBT_METADATA_CACHE_TTL_SECONDS);
}

/** Ghi marker NOT_FOUND TTL ngắn để giới hạn RPC amplification từ tokenId ngẫu nhiên. */
export async function setSbtTokenNotFoundCache(tokenId: number): Promise<void> {
  const cacheKey = buildSbtTokenNotFoundCacheKey(tokenId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, '1', { EX: SBT_NOT_FOUND_CACHE_TTL_SECONDS });
      return;
    } catch (error) {
      logger.warn('Redis set negative cache SBT thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  sbtFallbackCache.set(cacheKey, '1', SBT_NOT_FOUND_CACHE_TTL_SECONDS);
}

/** Xóa đúng một cache key ở cả Redis và in-memory fallback sau khi trạng thái đổi on-chain. */
export async function invalidateSbtTokenCache(tokenId: number): Promise<void> {
  const cacheKey = buildSbtTokenCacheKey(tokenId);
  const notFoundCacheKey = buildSbtTokenNotFoundCacheKey(tokenId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await Promise.all([
        redisClient.del(cacheKey),
        redisClient.del(notFoundCacheKey)
      ]);
    } catch (error) {
      logger.warn('Redis invalidate SBT metadata cache thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  // Luôn dọn fallback để không trả snapshot cũ sau khi Redis bị mất kết nối.
  sbtFallbackCache.deleteByKey(cacheKey);
  sbtFallbackCache.deleteByKey(notFoundCacheKey);
}
