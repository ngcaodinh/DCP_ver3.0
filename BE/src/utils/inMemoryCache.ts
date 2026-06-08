type InMemoryCacheEntry<TValue> = {
  value: TValue;
  expiredAtMilliseconds: number;
};

/** Hàm tạo cache in-memory đơn giản. Mục đích: tái sử dụng cho các endpoint cần cache TTL ngắn. */
export function createInMemoryCache<TValue>() {
  const cacheStore = new Map<string, InMemoryCacheEntry<TValue>>();

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

  /** Hàm ghi dữ liệu vào cache theo key. Mục đích: lưu kết quả truy vấn trong thời gian TTL cấu hình. */
  const set = (cacheKey: string, cacheValue: TValue, timeToLiveSeconds: number): void => {
    const expiredAtMilliseconds = Date.now() + timeToLiveSeconds * 1000;
    cacheStore.set(cacheKey, { value: cacheValue, expiredAtMilliseconds });
  };

  /** Hàm xóa một key cache. Mục đích: hỗ trợ invalidate chủ động khi cần. */
  const deleteByKey = (cacheKey: string): void => {
    cacheStore.delete(cacheKey);
  };

  /** Hàm xóa toàn bộ cache. Mục đích: hỗ trợ dọn dẹp trong test hoặc maintenance. */
  const clearAll = (): void => {
    cacheStore.clear();
  };

  return {
    get,
    set,
    deleteByKey,
    clearAll
  };
}
