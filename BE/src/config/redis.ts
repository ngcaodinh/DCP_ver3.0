import { createClient } from 'redis';
import { getLogger } from './logger';

/**
 * Hàm extract message từ error object.
 * Redis client error có thể là string hoặc object dạng {errorMessage: ''} thay vì {message: ''}.
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

const logger = getLogger();
let cachedRedisClient: ReturnType<typeof createClient> | null = null;
let isRedisConnectAttempted = false;

/** Hàm lấy Redis URL từ cấu hình. Mục đích: dùng giá trị mặc định local khi thiếu biến môi trường. */
function getRedisUrl(): string {
  return process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';
}

/** Hàm tạo Redis client singleton. Mục đích: tái sử dụng một kết nối Redis cho toàn ứng dụng. */
function getRedisClientSingleton() {
  if (!cachedRedisClient) {
    cachedRedisClient = createClient({ url: getRedisUrl() });

    // Ghi chú logic phức tạp: dùng .once() thay vì .on() để tránh đăng ký nhiều listener
    // mỗi khi ts-node-dev restart server → mỗi error chỉ được log ĐÚNG 1 lần.
    cachedRedisClient.once('error', error => {
      logger.warn('Redis client error.', { errorMessage: extractErrorMessage(error) });
    });
  }

  return cachedRedisClient;
}

/** Hàm kết nối Redis an toàn. Mục đích: tránh crash ứng dụng khi Redis chưa sẵn sàng. */
export async function connectToRedisSafely(): Promise<void> {
  const redisClient = getRedisClientSingleton();
  if (redisClient.isOpen) {
    return;
  }

  if (isRedisConnectAttempted) {
    return;
  }

  isRedisConnectAttempted = true;

  try {
    await redisClient.connect();
    logger.info('Redis connected successfully.');
  } catch (error) {
    logger.warn('Redis is unavailable. Application will fallback to non-cache mode.', {
      errorMessage: extractErrorMessage(error)
    });
  }
}

/** Hàm lấy Redis client nếu đã sẵn sàng. Mục đích: cho phép caller fallback khi Redis chưa kết nối được. */
export function getRedisClientIfReady() {
  const redisClient = getRedisClientSingleton();
  if (!redisClient.isOpen) {
    return null;
  }

  return redisClient;
}
