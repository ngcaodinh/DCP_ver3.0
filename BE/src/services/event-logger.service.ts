import { randomBytes } from 'node:crypto';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import {
  eventLoggerBufferDepth,
  eventLoggerDroppedTotal
} from '../config/metricsRegistry';
import { ProjectEventModel } from '../models/projectEventModel';
import { projectEventLogInputSchema } from '../validators/projectEventValidator';
import type { LogEventInput, ProjectEventSource, QueuedProjectEventRecord } from '../types/project-event.types';

export const EVENT_LOGGER_BUFFER_KEY = 'dcp:events:buffer';
export const EVENT_LOGGER_LIVE_CHANNEL = 'dcp:events:live';
export const EVENT_LOGGER_MAX_PAYLOAD_BYTES = 8 * 1024;

const DEFAULT_EVENT_LOGGER_BUFFER_MAX = 50_000;
const REDIS_FALLBACK_WARNING_INTERVAL_MS = 60_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;
const APPEND_EVENT_TO_BUFFER_SCRIPT = `
local currentLength = redis.call('LLEN', KEYS[1])
local bufferMax = tonumber(ARGV[1])
if currentLength >= bufferMax then
  return -currentLength
end
return redis.call('RPUSH', KEYS[1], ARGV[2])
`;
const logger = getLogger();
let lastRedisFallbackWarningAt = 0;

/** Đọc một số nguyên dương từ env và trả về giá trị mặc định khi cấu hình không hợp lệ. */
function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Sinh eventId ngay tại producer để cùng một payload giữ nguyên định danh khi retry. */
function createProjectEventId(): string {
  return `EVT-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/** Xác định process tạo event để phục vụ truy vết mà không phụ thuộc vào request context. */
function getEventSource(): ProjectEventSource {
  return process.env.RUN_WORKERS === 'false' ? 'api' : 'worker';
}

/** Cắt payload quá lớn thành marker bounded, tránh một event chiếm hết Redis buffer. */
function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  let serializedPayload: string | undefined;
  try {
    serializedPayload = JSON.stringify(payload);
  } catch {
    logger.warn('Event logger payload không thể serialize và đã được thay bằng marker.', {
      context: { serializationError: true }
    });
    return { truncated: true, serializationError: true };
  }
  if (serializedPayload === undefined) {
    return { truncated: true, serializationError: true };
  }
  const payloadBytes = Buffer.byteLength(serializedPayload, 'utf8');
  if (payloadBytes <= EVENT_LOGGER_MAX_PAYLOAD_BYTES) return payload;

  logger.warn('Event logger payload vượt giới hạn và đã được rút gọn.', {
    context: { payloadBytes, maxPayloadBytes: EVENT_LOGGER_MAX_PAYLOAD_BYTES }
  });
  return { truncated: true, originalSizeBytes: payloadBytes };
}

/** Cảnh báo bounded khi Redis chưa sẵn sàng để không spam log lúc hệ thống khởi động. */
function warnRedisFallbackOnce(reason: string): void {
  const now = Date.now();
  if (now - lastRedisFallbackWarningAt < REDIS_FALLBACK_WARNING_INTERVAL_MS) return;
  lastRedisFallbackWarningAt = now;
  logger.warn('Event logger chuyển sang ghi trực tiếp MongoDB vì Redis không sẵn sàng.', {
    context: { reason }
  });
}

/** Ghi trực tiếp MongoDB khi Redis không có, vẫn giữ event để không chặn nghiệp vụ caller. */
async function persistDirectlyToMongo(record: QueuedProjectEventRecord): Promise<void> {
  await ProjectEventModel.create({ ...record, createdAt: new Date() });
}

/** Đẩy event lên live channel trước rồi mới đưa vào buffer bền vững trong Redis LIST. */
async function publishAndBuffer(record: QueuedProjectEventRecord): Promise<void> {
  const redis = getRedisClientIfReady();
  if (!redis) {
    warnRedisFallbackOnce('REDIS_NOT_READY');
    await persistDirectlyToMongo(record);
    return;
  }

  const serializedRecord = JSON.stringify(record);
  try {
    try {
      await redis.publish(EVENT_LOGGER_LIVE_CHANNEL, serializedRecord);
    } catch (error) {
      logger.warn('Event logger publish realtime thất bại; buffer bền vững vẫn được ưu tiên.', {
        context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
      });
    }

    const bufferMax = readPositiveIntegerEnv('EVENT_LOGGER_BUFFER_MAX', DEFAULT_EVENT_LOGGER_BUFFER_MAX);
    // Lua gói LLEN + RPUSH trong cùng atomic operation, tránh nhiều producer cùng vượt bufferMax.
    const appendResult = Number(await redis.eval(APPEND_EVENT_TO_BUFFER_SCRIPT, {
      keys: [EVENT_LOGGER_BUFFER_KEY],
      arguments: [String(bufferMax), serializedRecord]
    }));
    if (!Number.isSafeInteger(appendResult)) {
      throw new Error('Redis buffer script trả về kết quả không hợp lệ.');
    }
    if (appendResult < 0) {
      const bufferLength = Math.abs(appendResult);
      eventLoggerBufferDepth.set(bufferLength);
      eventLoggerDroppedTotal.inc();
      logger.error('Event logger loại event mới vì Redis buffer đã đạt giới hạn.', {
        context: { bufferLength, bufferMax }
      });
      return;
    }

    eventLoggerBufferDepth.set(appendResult);
  } catch (error) {
    warnRedisFallbackOnce(error instanceof Error ? error.name : 'REDIS_OPERATION_FAILED');
    await persistDirectlyToMongo(record);
  }
}

/** Ghi một event nghiệp vụ theo kiểu fire-and-forget; lỗi logger không được lan vào business lane. */
export function logEvent(input: LogEventInput): void {
  try {
    if (process.env.EVENT_LOGGER_ENABLED === 'false') return;

    const parsedInput = projectEventLogInputSchema.safeParse(input);
    if (!parsedInput.success) {
      logger.error('Event logger từ chối payload không hợp lệ.', {
        context: { eventType: input.eventType, issueCount: parsedInput.error.issues.length }
      });
      return;
    }

    const eventId = createProjectEventId();
    const now = new Date();
    const timestamp = parsedInput.data.timestamp.getTime() > now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS
      ? now
      : parsedInput.data.timestamp;
    if (timestamp === now) {
      logger.warn('Event logger chuẩn hóa timestamp tương lai về thời điểm hiện tại.', {
        context: { eventId, eventType: parsedInput.data.eventType }
      });
    }

    const record: QueuedProjectEventRecord = {
      eventId,
      eventType: parsedInput.data.eventType,
      projectId: parsedInput.data.projectId?.trim() ?? null,
      timestamp,
      walletAddress: parsedInput.data.walletAddress?.trim().toLowerCase() ?? null,
      amount: parsedInput.data.amount ?? null,
      correlationId: parsedInput.data.correlationId?.trim() ?? null,
      organizationId: parsedInput.data.organizationId?.trim() ?? null,
      payload: normalizePayload(parsedInput.data.payload),
      source: getEventSource(),
      archiveState: 'HOT',
      archivedAt: null,
      archiveLocator: null,
      archiveChecksum: null,
      createdAt: null
    };

    void publishAndBuffer(record).catch(error => {
      logger.error('Event logger không thể persist event.', {
        context: { eventId, eventType: record.eventType, errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
      });
    });
  } catch (error) {
    logger.error('Event logger gặp lỗi nội bộ và đã bỏ qua.', {
      context: { errorName: error instanceof Error ? error.name : 'UNKNOWN_ERROR' }
    });
  }
}

/** Reset state cảnh báo nội bộ để test độc lập giữa các case. */
export function __resetEventLoggerStateForTest(): void {
  lastRedisFallbackWarningAt = 0;
}
