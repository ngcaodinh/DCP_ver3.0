import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const logger = getLogger();
const sbtFallbackCache = createInMemoryCache<string>();
const SBT_CACHE_KEY_PREFIX = 'sbt:token:';
const SBT_NOT_FOUND_CACHE_KEY_PREFIX = 'sbt:token:not-found:';
const SBT_GALLERY_TOTAL_CACHE_KEY_PREFIX = 'sbt:gallery:total:';
const SBT_GALLERY_TOTAL_LOCK_KEY_SUFFIX = ':lock';
const SBT_GALLERY_TOTAL_LOCK_TTL_MS = 5_000;
const SBT_GALLERY_TOTAL_WAIT_INTERVAL_MS = 50;
const SBT_GALLERY_TOTAL_WAIT_TIMEOUT_MS = 5_000;
export const SBT_METADATA_CACHE_TTL_SECONDS = 3_600;
export const SBT_NOT_FOUND_CACHE_TTL_SECONDS = 60;
export const SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS = 60;
const SBT_GALLERY_TOTAL_STALE_CACHE_TTL_SECONDS = 10 * 60;
const SBT_GALLERY_TOTAL_STALE_CACHE_MAX_ENTRIES = 500;
const sbtGalleryTotalLoadPromises = new Map<string, Promise<number>>();
const sbtGalleryTotalStaleCache = createInMemoryCache<number>({
  maxEntries: SBT_GALLERY_TOTAL_STALE_CACHE_MAX_ENTRIES
});

/** Tạo cache key ổn định cho metadata detail theo tokenId on-chain. */
export function buildSbtTokenCacheKey(tokenId: number): string {
  return `${SBT_CACHE_KEY_PREFIX}${tokenId}`;
}

/** Tạo cache key ổn định cho tổng số SBT gallery theo project hoặc toàn hệ thống. */
export function buildSbtGalleryTotalCacheKey(projectId?: string): string {
  const scope = projectId === undefined
    ? 'scope:global'
    : `scope:project:${encodeURIComponent(projectId)}`;
  return `${SBT_GALLERY_TOTAL_CACHE_KEY_PREFIX}${scope}`;
}

/** Chờ ngắn hạn để instance đang giữ Redis lock hoàn tất ghi total cache. */
async function waitForSbtGalleryTotalCache(projectId: string | undefined): Promise<number | null> {
  const deadline = Date.now() + SBT_GALLERY_TOTAL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, SBT_GALLERY_TOTAL_WAIT_INTERVAL_MS));
    const cachedTotal = await getSbtGalleryTotalCache(projectId);
    if (cachedTotal !== null) return cachedTotal;
  }
  return null;
}

/** Tính total dưới một single-flight nội bộ và Redis lock để tránh countDocuments stampede. */
export async function getOrLoadSbtGalleryTotal(
  projectId: string | undefined,
  loadTotal: () => Promise<number>
): Promise<number> {
  const cachedTotal = await getSbtGalleryTotalCache(projectId);
  if (cachedTotal !== null) return cachedTotal;

  const cacheKey = buildSbtGalleryTotalCacheKey(projectId);
  const inFlightLoad = sbtGalleryTotalLoadPromises.get(cacheKey);
  if (inFlightLoad) return inFlightLoad;

  const loadPromise = (async (): Promise<number> => {
    const redisClient = getRedisClientIfReady();
    if (redisClient) {
      let lockResult: string | null = null;
      try {
        lockResult = await redisClient.set(
          `${cacheKey}${SBT_GALLERY_TOTAL_LOCK_KEY_SUFFIX}`,
          String(process.pid),
          { NX: true, PX: SBT_GALLERY_TOTAL_LOCK_TTL_MS }
        );
      } catch (error) {
        logger.warn('Redis lock total gallery SBT thất bại, dùng single-flight in-memory.', {
          errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
        });
        lockResult = 'OK';
      }

      if (lockResult !== 'OK') {
        const sharedTotal = await waitForSbtGalleryTotalCache(projectId);
        if (sharedTotal !== null) return sharedTotal;

        const staleTotal = sbtGalleryTotalStaleCache.get(cacheKey);
        if (staleTotal !== null) return staleTotal;

        // Redis lock hết hạn nhưng writer không tạo được cache; tính lại để request không bị treo vô thời hạn.
        const total = await loadTotal();
        await setSbtGalleryTotalCache(projectId, total);
        return total;
      }
    }

    const total = await loadTotal();
    try {
      await setSbtGalleryTotalCache(projectId, total);
    } catch (error) {
      // Cache chỉ là tối ưu đọc; total từ Mongo vẫn hợp lệ để trả response.
      logger.warn('Không thể ghi total gallery SBT sau single-flight.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
    return total;
  })();

  sbtGalleryTotalLoadPromises.set(cacheKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    sbtGalleryTotalLoadPromises.delete(cacheKey);
  }
}

/** Phân tích giá trị tổng gallery trong cache và loại bỏ dữ liệu âm hoặc không an toàn. */
function parseSbtGalleryTotal(value: string | null): number | null {
  if (value === null) return null;

  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
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

/** Đọc tổng số SBT gallery từ Redis hoặc fallback in-memory để giảm countDocuments public. */
export async function getSbtGalleryTotalCache(projectId?: string): Promise<number | null> {
  const cacheKey = buildSbtGalleryTotalCacheKey(projectId);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      const cachedTotal = parseSbtGalleryTotal(await redisClient.get(cacheKey));
      if (cachedTotal !== null) {
        sbtGalleryTotalStaleCache.set(cacheKey, cachedTotal, SBT_GALLERY_TOTAL_STALE_CACHE_TTL_SECONDS);
        return cachedTotal;
      }
    } catch (error) {
      logger.warn('Redis get tổng gallery SBT thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  const cachedTotal = parseSbtGalleryTotal(sbtFallbackCache.get(cacheKey));
  if (cachedTotal !== null) {
    sbtGalleryTotalStaleCache.set(cacheKey, cachedTotal, SBT_GALLERY_TOTAL_STALE_CACHE_TTL_SECONDS);
  }
  return cachedTotal;
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

/** Ghi tổng số SBT gallery với TTL ngắn vì dữ liệu có thể thay đổi sau khi mint hoặc thu hồi. */
export async function setSbtGalleryTotalCache(projectId: string | undefined, total: number): Promise<void> {
  if (!Number.isSafeInteger(total) || total < 0) return;

  const cacheKey = buildSbtGalleryTotalCacheKey(projectId);
  const serializedTotal = String(total);
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, serializedTotal, { EX: SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS });
      sbtGalleryTotalStaleCache.set(cacheKey, total, SBT_GALLERY_TOTAL_STALE_CACHE_TTL_SECONDS);
      return;
    } catch (error) {
      logger.warn('Redis set tổng gallery SBT thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  sbtFallbackCache.set(cacheKey, serializedTotal, SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS);
  sbtGalleryTotalStaleCache.set(cacheKey, total, SBT_GALLERY_TOTAL_STALE_CACHE_TTL_SECONDS);
}

/** Xóa cache total toàn cục và theo project khi trạng thái on-chain làm thay đổi visibility. */
export async function invalidateSbtGalleryTotalCache(projectId?: string): Promise<void> {
  const cacheKeys = [buildSbtGalleryTotalCacheKey()];
  if (projectId !== undefined) {
    cacheKeys.push(buildSbtGalleryTotalCacheKey(projectId));
  }
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await Promise.all(cacheKeys.map(cacheKey => redisClient.del(cacheKey)));
    } catch (error) {
      logger.warn('Redis invalidate total gallery SBT thất bại.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  for (const cacheKey of cacheKeys) {
    sbtFallbackCache.deleteByKey(cacheKey);
    sbtGalleryTotalStaleCache.deleteByKey(cacheKey);
  }
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
