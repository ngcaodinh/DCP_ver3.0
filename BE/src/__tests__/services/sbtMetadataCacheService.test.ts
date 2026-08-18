import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

import {
  buildSbtGalleryTotalCacheKey,
  buildSbtTokenCacheKey,
  getSbtTokenCache,
  getOrLoadSbtGalleryTotal,
  getSbtGalleryTotalCache,
  invalidateSbtGalleryTotalCache,
  setSbtGalleryTotalCache,
  setSbtTokenCache,
  invalidateSbtTokenCache,
  SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS
} from '../../services/sbtMetadataCacheService';
import { getRedisClientIfReady } from '../../config/redis';

type RedisClientMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function createRedisClientMock(): RedisClientMock {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn()
  };
}

function useRedisClient(redisClient: RedisClientMock): void {
  vi.mocked(getRedisClientIfReady).mockReturnValue(
    redisClient as unknown as NonNullable<ReturnType<typeof getRedisClientIfReady>>
  );
}

describe('sbt gallery total cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClientIfReady).mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses separate stable keys for global and project totals', () => {
    expect(buildSbtGalleryTotalCacheKey()).toBe('sbt:gallery:total:scope:global');
    expect(buildSbtGalleryTotalCacheKey('project-1')).toBe('sbt:gallery:total:scope:project:project-1');
    expect(buildSbtGalleryTotalCacheKey()).not.toBe(buildSbtGalleryTotalCacheKey('all'));
  });

  it('round-trips a non-negative total through the in-memory fallback', async () => {
    await setSbtGalleryTotalCache('project-cache', 42);

    await expect(getSbtGalleryTotalCache('project-cache')).resolves.toBe(42);
  });

  it('does not store invalid totals and expires valid totals at the configured TTL', async () => {
    vi.useFakeTimers();
    await setSbtGalleryTotalCache('project-invalid', -1);
    await expect(getSbtGalleryTotalCache('project-invalid')).resolves.toBeNull();

    await setSbtGalleryTotalCache('project-expiring', 7);
    vi.advanceTimersByTime(SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS * 1000 + 1);

    await expect(getSbtGalleryTotalCache('project-expiring')).resolves.toBeNull();
  });

  it('coalesces concurrent cache misses so only one count runs for a gallery scope', async () => {
    let resolveCount: ((total: number) => void) | undefined;
    const countGallery = vi.fn(() => new Promise<number>(resolve => {
      resolveCount = resolve;
    }));

    const firstRequest = getOrLoadSbtGalleryTotal('project-single-flight', countGallery);
    const secondRequest = getOrLoadSbtGalleryTotal('project-single-flight', countGallery);

    await vi.waitFor(() => expect(countGallery).toHaveBeenCalledTimes(1));
    resolveCount?.(8);

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([8, 8]);
    await expect(getSbtGalleryTotalCache('project-single-flight')).resolves.toBe(8);
  });

  it('lets the Redis lock owner compute and persist a missing total', async () => {
    const redisClient = createRedisClientMock();
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue('OK');
    useRedisClient(redisClient);
    const loadTotal = vi.fn().mockResolvedValue(15);

    await expect(getOrLoadSbtGalleryTotal('project-lock-owner', loadTotal)).resolves.toBe(15);

    expect(loadTotal).toHaveBeenCalledTimes(1);
    expect(redisClient.set).toHaveBeenCalledWith(
      'sbt:gallery:total:scope:project:project-lock-owner:lock',
      String(process.pid),
      { NX: true, PX: 5_000 }
    );
    expect(redisClient.set).toHaveBeenCalledWith(
      'sbt:gallery:total:scope:project:project-lock-owner',
      '15',
      { EX: SBT_GALLERY_TOTAL_CACHE_TTL_SECONDS }
    );
  });

  it('returns a valid Redis total without querying Mongo and ignores malformed Redis data', async () => {
    const redisClient = createRedisClientMock();
    redisClient.get.mockResolvedValueOnce('27').mockResolvedValueOnce('not-a-number');
    useRedisClient(redisClient);

    await expect(getSbtGalleryTotalCache('project-redis-hit')).resolves.toBe(27);
    await expect(getSbtGalleryTotalCache('project-redis-invalid')).resolves.toBeNull();
  });

  it('returns the cached total without invoking the loader on a cache hit', async () => {
    await setSbtGalleryTotalCache('project-cache-hit', 14);
    const loadTotal = vi.fn().mockResolvedValue(99);

    await expect(getOrLoadSbtGalleryTotal('project-cache-hit', loadTotal)).resolves.toBe(14);
    expect(loadTotal).not.toHaveBeenCalled();
  });

  it('uses a shared Redis total when another instance owns the lock', async () => {
    const redisClient = createRedisClientMock();
    redisClient.get.mockResolvedValueOnce(null).mockResolvedValueOnce('22');
    redisClient.set.mockResolvedValue(null);
    useRedisClient(redisClient);
    const loadTotal = vi.fn().mockResolvedValue(99);

    await expect(getOrLoadSbtGalleryTotal('project-lock-loser', loadTotal)).resolves.toBe(22);

    expect(loadTotal).not.toHaveBeenCalled();
  });

  it('uses bounded stale data after the Redis lock wait expires', async () => {
    vi.useFakeTimers();
    const redisClient = createRedisClientMock();
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue('OK');
    useRedisClient(redisClient);
    await setSbtGalleryTotalCache('project-stale', 31);

    redisClient.set.mockResolvedValue(null);
    const loadTotal = vi.fn().mockResolvedValue(99);
    const request = getOrLoadSbtGalleryTotal('project-stale', loadTotal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toBe(31);
    expect(loadTotal).not.toHaveBeenCalled();
  });

  it('recomputes after bounded stale data expires', async () => {
    vi.useFakeTimers();
    const redisClient = createRedisClientMock();
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue('OK');
    vi.mocked(getRedisClientIfReady).mockReturnValueOnce(null);
    await setSbtGalleryTotalCache('project-stale-expired', 31);
    useRedisClient(redisClient);
    redisClient.set.mockResolvedValue(null);
    vi.advanceTimersByTime(10 * 60 * 1_000 + 1);
    const loadTotal = vi.fn().mockResolvedValue(99);

    const request = getOrLoadSbtGalleryTotal('project-stale-expired', loadTotal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toBe(99);
    expect(loadTotal).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest stale scope instead of retaining unbounded project keys', async () => {
    vi.useFakeTimers();
    const redisClient = createRedisClientMock();
    redisClient.set.mockResolvedValue('OK');
    useRedisClient(redisClient);

    for (let index = 0; index <= 500; index += 1) {
      await setSbtGalleryTotalCache(`project-eviction-${index}`, index);
    }

    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue(null);
    const loadTotal = vi.fn().mockResolvedValue(999);
    const request = getOrLoadSbtGalleryTotal('project-eviction-0', loadTotal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toBe(999);
    expect(loadTotal).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bounded in-memory cache when Redis operations fail', async () => {
    const redisClient = createRedisClientMock();
    redisClient.get.mockRejectedValue(new Error('Redis unavailable'));
    redisClient.set.mockRejectedValue(new Error('Redis unavailable'));
    useRedisClient(redisClient);
    const loadTotal = vi.fn().mockResolvedValue(12);

    await expect(getOrLoadSbtGalleryTotal('project-redis-error', loadTotal)).resolves.toBe(12);
    await expect(getSbtGalleryTotalCache('project-redis-error')).resolves.toBe(12);
  });

  it('invalidates Redis and fallback totals even when Redis delete fails', async () => {
    await setSbtGalleryTotalCache('project-invalidate-error', 18);
    const redisClient = createRedisClientMock();
    redisClient.del.mockRejectedValue(new Error('Redis unavailable'));
    useRedisClient(redisClient);

    await invalidateSbtGalleryTotalCache('project-invalidate-error');

    expect(redisClient.del).toHaveBeenCalledTimes(2);
    vi.mocked(getRedisClientIfReady).mockReturnValue(null);
    await expect(getSbtGalleryTotalCache()).resolves.toBeNull();
    await expect(getSbtGalleryTotalCache('project-invalidate-error')).resolves.toBeNull();
  });

  it('cleans up a rejected single-flight load so the next request can retry', async () => {
    const loadTotal = vi.fn()
      .mockRejectedValueOnce(new Error('Mongo unavailable'))
      .mockResolvedValueOnce(21);

    await expect(getOrLoadSbtGalleryTotal('project-load-retry', loadTotal)).rejects.toThrow('Mongo unavailable');
    await expect(getOrLoadSbtGalleryTotal('project-load-retry', loadTotal)).resolves.toBe(21);
    expect(loadTotal).toHaveBeenCalledTimes(2);
  });

  it('invalidates global and project totals without allowing projectId=all to poison global pagination', async () => {
    await Promise.all([
      setSbtGalleryTotalCache(undefined, 10),
      setSbtGalleryTotalCache('all', 1)
    ]);

    await invalidateSbtGalleryTotalCache('all');

    await expect(getSbtGalleryTotalCache()).resolves.toBeNull();
    await expect(getSbtGalleryTotalCache('all')).resolves.toBeNull();
  });
});

describe('sbt token detail cache', () => {
  it('scopes token keys by environment, chain and contract and invalidates detail snapshots', async () => {
    const cacheKey = buildSbtTokenCacheKey(42);
    expect(cacheKey).toMatch(/^sbt:token:v2:[^:]+:[^:]+:[^:]+:42$/);

    await setSbtTokenCache(42, '{"status":"ACTIVE"}');
    await expect(getSbtTokenCache(42)).resolves.toBe('{"status":"ACTIVE"}');
    await invalidateSbtTokenCache(42);
    await expect(getSbtTokenCache(42)).resolves.toBeNull();
  });
});
