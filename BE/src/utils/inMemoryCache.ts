type InMemoryCacheEntry<TValue> = {
  value: TValue;
  expiredAtMilliseconds: number;
};

type InMemoryCacheOptions = {
  maxEntries?: number;
};

/**
 * Hàm tạo cache in-memory đơn giản với giới hạn số entries.
 * Mục đích: tái sử dụng cho các endpoint cần cache TTL ngắn.
 * Khi số entries vượt maxEntries, entry cũ nhất sẽ bị xóa trước.
 */
export function createInMemoryCache<TValue>(options: InMemoryCacheOptions = {}) {
  const { maxEntries = 500 } = options;
  const cacheStore = new Map<string, InMemoryCacheEntry<TValue>>();

  /**
   * Xóa entry cũ nhất khi cache vượt giới hạn maxEntries.
   * Sử dụng Map.keys() để lấy thứ tự insertion (cũ nhất).
   */
  const evictIfNeeded = (): void => {
    if (cacheStore.size >= maxEntries) {
      const oldestKey = cacheStore.keys().next().value;
      if (oldestKey !== undefined) {
        cacheStore.delete(oldestKey);
      }
    }
  };

  /** Hàm lấy dữ liệu từ cache theo key. Mục đích: trả null nếu không có key hoặc đã hết hạn TTL. */
  const get = (cacheKey: string): TValue | null => {
    const cacheEntry = cacheStore.get(cacheKey);
    if (!cacheEntry) {
      return null;
    }

    if (Date.now() > cacheEntry.expiredAtMilliseconds) {
      cacheStore.delete(cacheKey);
      return null;
    }

    return cacheEntry.value;
  };

  /**
   * Hàm ghi dữ liệu vào cache theo key.
   * Mục đích: lưu kết quả truy vấn trong thời gian TTL cấu hình.
   * Nếu cache đầy, xóa entry cũ nhất trước khi thêm mới.
   */
  const set = (cacheKey: string, cacheValue: TValue, timeToLiveSeconds: number): void => {
    evictIfNeeded();
    const expiredAtMilliseconds = Date.now() + timeToLiveSeconds * 1000;
    cacheStore.set(cacheKey, { value: cacheValue, expiredAtMilliseconds });
  };

  /** Hàm xóa một key cache. Mục đích: hỗ trợ invalidate chủ động khi cần. */
  const deleteByKey = (cacheKey: string): void => {
    cacheStore.delete(cacheKey);
  };

  /** Xóa các entry cùng namespace để invalidate theo project mà không ảnh hưởng cache khác. */
  const deleteByPrefix = (prefix: string): void => {
    for (const cacheKey of cacheStore.keys()) {
      if (cacheKey.startsWith(prefix)) {
        cacheStore.delete(cacheKey);
      }
    }
  };

  /** Hàm xóa toàn bộ cache. Mục đích: hỗ trợ dọn dẹp trong test hoặc maintenance. */
  const clearAll = (): void => {
    cacheStore.clear();
  };

  return {
    get,
    set,
    deleteByKey,
    deleteByPrefix,
    clearAll
  };
}
