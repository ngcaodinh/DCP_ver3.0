/**
 * ⚠️ NGỪNG SỬ DỤNG từ 2026-08-27 — chức năng ghi đè GPS đã khai tử.
 * Lý do: minh chứng nay chụp trực tiếp qua camera nên luôn có tọa độ.
 * Giữ file để đọc lại dữ liệu lịch sử. Xem ADR-2026-08-27.
 */
import { getRedisClientIfReady } from '../config/redis';
import { findActiveCommissioners, type AuthUser } from '../models/authModel';

const COMMISSIONER_CACHE_KEY = 'commissioners:active';
const COMMISSIONER_CACHE_TTL_SECONDS = 5;

/**
 * Lấy danh sách commissioner ACTIVE từ cache dùng chung hoặc fallback về MongoDB.
 * TTL ngắn giúp giảm truy vấn lặp nhưng vẫn giới hạn thời gian giữ quyền cũ.
 */
export async function getCachedActiveCommissioners(): Promise<AuthUser[]> {
  const redis = getRedisClientIfReady();
  if (redis) {
    try {
      const cached = await redis.get(COMMISSIONER_CACHE_KEY);
      if (cached) return JSON.parse(cached) as AuthUser[];

      const fresh = await findActiveCommissioners();
      await redis.setEx(
        COMMISSIONER_CACHE_KEY,
        COMMISSIONER_CACHE_TTL_SECONDS,
        JSON.stringify(fresh)
      );
      return fresh;
    } catch {
      // Redis lỗi thì vẫn phải tiếp tục bằng dữ liệu mới nhất từ DB.
    }
  }

  return findActiveCommissioners();
}
