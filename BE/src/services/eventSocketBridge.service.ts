import { getLogger } from '../config/logger';
import { getRedisClientIfReady, onRedisReady } from '../config/redis';
import { getSocketServer } from '../config/socketServer';
import { eventSocketBridgeConnected } from '../config/metricsRegistry';
import { PROJECT_EVENT_TYPES, type ProjectEventType } from '../constants/projectEventTypes';
import { EVENT_LOGGER_LIVE_CHANNEL } from './event-logger.service';
import { maskWalletAddress } from '../utils/maskWalletAddress';

const logger = getLogger();
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
type RedisClient = NonNullable<ReturnType<typeof getRedisClientIfReady>>;
type LiveEventSubscriber = ReturnType<RedisClient['duplicate']>;

let subscriber: LiveEventSubscriber | null = null;
let redisReadyUnsubscribe: (() => void) | null = null;

/** Hủy listener chờ Redis để shutdown và retry không tích lũy callback qua hot-reload. */
function clearRedisReadyListener(): void {
  redisReadyUnsubscribe?.();
  redisReadyUnsubscribe = null;
}

/** Chờ Redis singleton sẵn sàng rồi khởi tạo lại bridge nếu startup trước đó bị hụt kết nối. */
function waitForRedisReady(): void {
  if (redisReadyUnsubscribe) return;
  redisReadyUnsubscribe = onRedisReady(() => {
    clearRedisReadyListener();
    initializeEventSocketBridge();
  });
}

/** Kiểm tra event JSON đến từ Redis có đủ cấu trúc tối thiểu trước khi phát socket. */
function parseLiveEvent(message: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.eventType !== 'string' || !PROJECT_EVENT_TYPES.includes(record.eventType as ProjectEventType)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/** Chuyển event nội bộ thành payload live đã che wallet trước khi rời backend. */
function toSocketPayload(record: Record<string, unknown>): Record<string, unknown> {
  const walletAddress = typeof record.walletAddress === 'string'
    ? maskWalletAddress(record.walletAddress)
    : null;
  return {
    eventId: record.eventId,
    eventType: record.eventType,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    timestamp: record.timestamp,
    walletAddress,
    amount: typeof record.amount === 'number' ? record.amount : null,
    correlationId: typeof record.correlationId === 'string' ? record.correlationId : null,
    organizationId: typeof record.organizationId === 'string' ? record.organizationId : null,
    payload: record.payload && typeof record.payload === 'object' ? record.payload : {}
  };
}

/** Phát event vào room project hoặc admin theo policy dữ liệu nhạy cảm của G4. */
function emitLiveEvent(message: string): void {
  const io = getSocketServer();
  if (!io) return;

  const record = parseLiveEvent(message);
  if (!record) {
    logger.warn('Event socket bridge bỏ qua message Redis không hợp lệ.');
    return;
  }

  const eventType = record.eventType as ProjectEventType;
  const socketPayload = toSocketPayload(record);
  if (eventType === 'SYBIL_FLAGGED') {
    io.to('admin').emit('event:new', socketPayload);
    return;
  }

  const projectId = typeof record.projectId === 'string' ? record.projectId : null;
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) return;
  io.to(`events:${projectId}`).emit('event:new', socketPayload);
}

/** Khởi tạo Redis subscriber ở cả API process và worker process để live event không phụ thuộc memory. */
export function initializeEventSocketBridge(): void {
  if (subscriber) return;
  const redis = getRedisClientIfReady();
  if (!redis) {
    eventSocketBridgeConnected.set(0);
    waitForRedisReady();
    logger.warn('Event socket bridge chưa khởi động vì Redis chưa sẵn sàng.');
    return;
  }

  clearRedisReadyListener();
  const nextSubscriber = redis.duplicate();
  subscriber = nextSubscriber;
  eventSocketBridgeConnected.set(0);
  nextSubscriber.on('error', error => {
    logger.warn('Event socket bridge Redis subscriber gặp lỗi.', {
      context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
    });
  });

  void (async () => {
    let connectionEstablished = false;
    let isSubscribed = false;
    let subscribePromise: Promise<void> | null = null;

    /** Đăng ký channel tối đa một lần cho mỗi trạng thái kết nối Redis. */
    const ensureLiveSubscription = (): Promise<void> => {
      if (isSubscribed) return Promise.resolve();
      if (subscribePromise) return subscribePromise;

      subscribePromise = nextSubscriber.subscribe(EVENT_LOGGER_LIVE_CHANNEL, emitLiveEvent)
        .then(() => {
          isSubscribed = true;
        })
        .finally(() => {
          subscribePromise = null;
        });
      return subscribePromise;
    };

    // Khi node-redis nối lại, trạng thái subscribe phải được xác lập lại trước khi nhận event mới.
    nextSubscriber.on('reconnecting', () => {
      isSubscribed = false;
      eventSocketBridgeConnected.set(0);
    });
    nextSubscriber.on('ready', () => {
      if (!connectionEstablished) return;
      void ensureLiveSubscription()
        .then(() => {
          eventSocketBridgeConnected.set(1);
        })
        .catch(error => {
          logger.warn('Event socket bridge chưa subscribe lại sau Redis reconnect.', {
            context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
          });
        });
    });

    try {
      await nextSubscriber.connect();
      connectionEstablished = true;
      await ensureLiveSubscription();
      eventSocketBridgeConnected.set(1);
    } catch (error) {
      logger.error('Event socket bridge không thể subscribe Redis channel.', {
        context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
      });
      eventSocketBridgeConnected.set(0);
      if (subscriber === nextSubscriber) subscriber = null;
      await nextSubscriber.quit().catch(() => undefined);
      waitForRedisReady();
    }
  })();
}

/** Đóng subscriber Redis của event bridge khi graceful shutdown. */
export async function shutdownEventSocketBridge(): Promise<void> {
  clearRedisReadyListener();
  eventSocketBridgeConnected.set(0);
  const currentSubscriber = subscriber;
  subscriber = null;
  if (!currentSubscriber) return;

  await currentSubscriber.unsubscribe(EVENT_LOGGER_LIVE_CHANNEL).catch(() => undefined);
  await currentSubscriber.quit().catch(() => undefined);
}
