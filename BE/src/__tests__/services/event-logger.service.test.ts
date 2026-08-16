import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: null as {
    publish: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  } | null,
  create: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => mocks.redis)
}));
vi.mock('../../models/projectEventModel', () => ({
  ProjectEventModel: { create: mocks.create }
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  __resetEventLoggerStateForTest,
  EVENT_LOGGER_BUFFER_KEY,
  EVENT_LOGGER_LIVE_CHANNEL,
  logEvent
} from '../../services/event-logger.service';

function createRedisMock() {
  return {
    publish: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1)
  };
}

function validDonationInput() {
  return {
    eventType: 'DONATION_CONFIRMED' as const,
    projectId: 'project-1',
    walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    amount: 100,
    correlationId: 'donation:0xtx',
    timestamp: new Date('2026-08-16T00:00:00.000Z'),
    payload: { transactionHash: '0xtx', blockNumber: 10, isAnonymous: false }
  };
}

describe('event-logger.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EVENT_LOGGER_ENABLED = 'true';
    process.env.EVENT_LOGGER_BUFFER_MAX = '50000';
    mocks.redis = createRedisMock();
    mocks.create.mockResolvedValue({});
    __resetEventLoggerStateForTest();
  });

  it('publish realtime trước rồi append atomic record có eventId ổn định vào buffer', async () => {
    logEvent(validDonationInput());
    await vi.waitFor(() => expect(mocks.redis?.eval).toHaveBeenCalledTimes(1));

    const publishedPayload = JSON.parse(mocks.redis!.publish.mock.calls[0][1] as string) as Record<string, unknown>;
    const bufferedPayload = JSON.parse(mocks.redis!.eval.mock.calls[0][1].arguments[1] as string) as Record<string, unknown>;
    expect(mocks.redis!.publish).toHaveBeenCalledWith(EVENT_LOGGER_LIVE_CHANNEL, expect.any(String));
    expect(mocks.redis!.eval.mock.calls[0][1].keys).toEqual([EVENT_LOGGER_BUFFER_KEY]);
    expect(publishedPayload.eventId).toBe(bufferedPayload.eventId);
    expect(bufferedPayload.walletAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(bufferedPayload.createdAt).toBeNull();
  });

  it('Redis null thì ghi trực tiếp Mongo và không ném lỗi ra caller', async () => {
    mocks.redis = null;
    expect(() => logEvent(validDonationInput())).not.toThrow();
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      eventType: 'DONATION_CONFIRMED',
      archiveState: 'HOT',
      createdAt: expect.any(Date)
    }));
  });

  it('Redis buffer script lỗi thì fallback Mongo với cùng event record', async () => {
    mocks.redis!.eval.mockRejectedValue(new Error('redis unavailable'));
    logEvent(validDonationInput());
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toEqual(expect.objectContaining({ eventType: 'DONATION_CONFIRMED' }));
  });

  it('payload không hợp lệ bị từ chối và buffer đầy thì drop event mới', async () => {
    logEvent({ ...validDonationInput(), amount: -1 });
    await Promise.resolve();
    expect(mocks.redis!.eval).not.toHaveBeenCalled();

    mocks.redis!.eval.mockResolvedValue(-50_000);
    logEvent(validDonationInput());
    await vi.waitFor(() => expect(mocks.logger.error).toHaveBeenCalled());
    expect(mocks.redis!.eval).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('nhiều producer gần đầy buffer chỉ append đủ số event atomic và drop phần còn lại', async () => {
    let currentLength = 0;
    const bufferMax = 2;
    process.env.EVENT_LOGGER_BUFFER_MAX = String(bufferMax);
    mocks.redis!.eval.mockImplementation(async (_script: string, options: { arguments: string[] }) => {
      const requestedMax = Number(options.arguments[0]);
      if (currentLength >= requestedMax) return -currentLength;
      currentLength += 1;
      return currentLength;
    });

    for (let index = 0; index < 10; index += 1) {
      logEvent({ ...validDonationInput(), correlationId: `donation:${index}` });
    }
    await vi.waitFor(() => expect(mocks.redis!.eval).toHaveBeenCalledTimes(10));

    expect(currentLength).toBe(bufferMax);
    expect(mocks.logger.error).toHaveBeenCalledTimes(8);
  });

  it('payload không serialize được thì ghi marker bounded thay vì làm mất event', async () => {
    logEvent({
      ...validDonationInput(),
      payload: {
        transactionHash: '0xtx',
        blockNumber: 10,
        isAnonymous: false,
        providerValue: BigInt(1)
      }
    });
    await vi.waitFor(() => expect(mocks.redis!.eval).toHaveBeenCalledTimes(1));

    const bufferedPayload = JSON.parse(mocks.redis!.eval.mock.calls[0][1].arguments[1] as string) as Record<string, unknown>;
    expect(bufferedPayload.payload).toEqual({ truncated: true, serializationError: true });
  });
});
