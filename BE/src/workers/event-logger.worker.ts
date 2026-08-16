import { randomUUID } from 'node:crypto';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { runWithWorkerContext } from '../config/requestContext';
import {
  eventLoggerBufferDepth,
  eventLoggerFlushDurationMs,
  eventLoggerFlushLagMs
} from '../config/metricsRegistry';
import { insertProjectEvents } from '../models/projectEventModel';
import {
  EVENT_LOGGER_BUFFER_KEY
} from '../services/event-logger.service';
import type { ProjectEventRecord, QueuedProjectEventRecord } from '../types/project-event.types';

const logger = getLogger();
const DEFAULT_TICK_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const INFLIGHT_KEY_PREFIX = 'dcp:events:inflight:';
const INFLIGHT_RECOVERY_AGE_MS = 5 * 60 * 1_000;

type RedisClient = NonNullable<ReturnType<typeof getRedisClientIfReady>>;

let intervalId: ReturnType<typeof setInterval> | null = null;
let activeFlushPromise: Promise<void> | null = null;
let isFlushing = false;
let lastFlushAt = Date.now();

/** Đọc env bounded để timer và batch size không nhận giá trị âm hoặc không an toàn. */
function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Tạo key inflight có timestamp để recovery không đụng batch đang được worker khác xử lý. */
function createInflightKey(): string {
  return `${INFLIGHT_KEY_PREFIX}${Date.now()}:${randomUUID()}`;
}

/** Xác định key inflight đã đủ cũ để worker hiện tại được phép recovery an toàn. */
function isRecoverableInflightKey(key: string, now: number): boolean {
  const timestamp = Number(key.slice(INFLIGHT_KEY_PREFIX.length).split(':')[0]);
  return Number.isFinite(timestamp) && now - timestamp >= INFLIGHT_RECOVERY_AGE_MS;
}

/** Kiểm tra tối thiểu record JSON trước khi đưa dữ liệu Redis vào insertMany. */
function parseQueuedEventRecord(serializedRecord: string): QueuedProjectEventRecord {
  const parsedRecord: unknown = JSON.parse(serializedRecord);
  if (!parsedRecord || typeof parsedRecord !== 'object') {
    throw new Error('Queued event không phải object.');
  }
  const record = parsedRecord as Partial<QueuedProjectEventRecord>;
  if (typeof record.eventId !== 'string' || typeof record.eventType !== 'string' || !(record.timestamp instanceof Date || typeof record.timestamp === 'string')) {
    throw new Error('Queued event thiếu định danh hoặc timestamp.');
  }
  return record as QueuedProjectEventRecord;
}

/** Nhận diện lỗi duplicate-only để retry batch at-least-once không bị coi là failure. */
function isDuplicateOnlyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: number; writeErrors?: Array<{ code?: number }> };
  if (Array.isArray(candidate.writeErrors) && candidate.writeErrors.length > 0) {
    return candidate.writeErrors.every(writeError => writeError.code === 11000);
  }
  return candidate.code === 11000;
}

/** Ghi một key inflight và chỉ xoá key sau khi insertMany hoàn tất hoặc duplicate-only. */
async function processInflightKey(redis: RedisClient, inflightKey: string): Promise<void> {
  const serializedRecords = await redis.lRange(inflightKey, 0, -1);
  if (serializedRecords.length === 0) {
    await redis.del(inflightKey);
    return;
  }

  const queuedRecords = serializedRecords.map(parseQueuedEventRecord);
  const flushCreatedAt = new Date();
  const records: ProjectEventRecord[] = queuedRecords.map(record => ({
    ...record,
    createdAt: flushCreatedAt
  }));

  try {
    await insertProjectEvents(records);
  } catch (error) {
    if (!isDuplicateOnlyError(error)) throw error;
    logger.warn('Event logger gặp duplicate eventId trong batch retry; xem như đã ghi.', {
      context: { inflightKey, recordCount: records.length }
    });
  }

  await redis.del(inflightKey);
  for (const record of records) {
    eventLoggerFlushLagMs.observe(Math.max(0, record.createdAt.getTime() - new Date(record.timestamp).getTime()));
  }
}

/** Quét và retry inflight key cũ trước khi lấy batch mới từ buffer chính. */
async function recoverInflightKeys(redis: RedisClient): Promise<void> {
  const now = Date.now();
  for await (const keyChunk of redis.scanIterator({ MATCH: `${INFLIGHT_KEY_PREFIX}*`, COUNT: 100 })) {
    for (const key of keyChunk) {
      if (!isRecoverableInflightKey(key, now)) continue;
      try {
        await processInflightKey(redis, key);
      } catch (error) {
        logger.error('Event logger recovery inflight thất bại; key sẽ được retry.', {
          context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
        });
      }
    }
  }
}

/** Thực hiện một tick duy nhất; cả ngưỡng số lượng và thời gian được đánh giá cùng một timer. */
async function runEventLoggerTickInternal(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;
  const startedAt = Date.now();

  try {
    const redis = getRedisClientIfReady();
    if (!redis) return;

    await recoverInflightKeys(redis);
    const bufferLength = await redis.lLen(EVENT_LOGGER_BUFFER_KEY);
    eventLoggerBufferDepth.set(bufferLength);
    const batchSize = readPositiveIntegerEnv('EVENT_LOGGER_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    const flushIntervalMs = readPositiveIntegerEnv('EVENT_LOGGER_FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS);
    const shouldFlush = bufferLength >= batchSize || Date.now() - lastFlushAt >= flushIntervalMs;
    if (!shouldFlush) return;

    if (bufferLength === 0) {
      lastFlushAt = Date.now();
      return;
    }

    const inflightKey = createInflightKey();
    try {
      await redis.rename(EVENT_LOGGER_BUFFER_KEY, inflightKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
      if (errorMessage.includes('no such key')) {
        return;
      }
      throw error;
    }

    await processInflightKey(redis, inflightKey);
    lastFlushAt = Date.now();
    eventLoggerBufferDepth.set(await redis.lLen(EVENT_LOGGER_BUFFER_KEY));
  } catch (error) {
    logger.error('Event logger worker flush thất bại; dữ liệu Redis được giữ để retry.', {
      context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
    });
  } finally {
    eventLoggerFlushDurationMs.observe(Date.now() - startedAt);
    isFlushing = false;
  }
}

/** Chạy một vòng worker trong correlation context để toàn bộ log có workerRunId. */
export async function runEventLoggerOnce(): Promise<void> {
  await runWithWorkerContext('event-logger', runEventLoggerTickInternal);
}

/** Khởi động một timer duy nhất cho cả điều kiện flush theo số lượng và theo thời gian. */
export function startEventLoggerWorker(): void {
  if (intervalId) return;
  if (process.env.EVENT_LOGGER_ENABLED === 'false') {
    logger.warn('Event logger worker chưa bật: EVENT_LOGGER_ENABLED khác "true".');
    return;
  }

  lastFlushAt = Date.now();
  triggerEventLoggerTick();
  intervalId = setInterval(() => {
    triggerEventLoggerTick();
  }, readPositiveIntegerEnv('EVENT_LOGGER_TICK_MS', DEFAULT_TICK_INTERVAL_MS));
}

/** Kích hoạt tick và lưu promise để shutdown có thể chờ đúng lượt flush đang chạy. */
function triggerEventLoggerTick(): void {
  const promise = runEventLoggerOnce();
  activeFlushPromise = promise;
  void promise.then(
    () => { if (activeFlushPromise === promise) activeFlushPromise = null; },
    () => { if (activeFlushPromise === promise) activeFlushPromise = null; }
  );
}

/** Dừng timer và chờ một lượt flush cuối với giới hạn 10 giây để shutdown không bị treo. */
export async function stopEventLoggerWorker(): Promise<void> {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;

  const finalFlush = activeFlushPromise ?? runEventLoggerOnce();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    finalFlush,
    new Promise<void>(resolve => {
      timeoutId = setTimeout(resolve, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    })
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  activeFlushPromise = null;
}

/** Reset state timer và lock để test worker isolated không giữ timer từ case trước. */
export function __resetEventLoggerWorkerState(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  activeFlushPromise = null;
  isFlushing = false;
  lastFlushAt = Date.now();
}
