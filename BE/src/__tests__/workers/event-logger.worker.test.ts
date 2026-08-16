import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: null as ReturnType<typeof createRedisMock> | null,
  insertMany: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

function createRedisMock() {
  return {
    lLen: vi.fn(),
    lRange: vi.fn(),
    rename: vi.fn(),
    del: vi.fn(),
    scanIterator: vi.fn(async function* (): AsyncGenerator<string[], void, void> {
      yield [];
    })
  };
}

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => mocks.redis)
}));
vi.mock('../../models/projectEventModel', () => ({
  insertProjectEvents: mocks.insertMany
}));
vi.mock('../../services/event-logger.service', () => ({
  EVENT_LOGGER_BUFFER_KEY: 'dcp:events:buffer'
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  __resetEventLoggerWorkerState,
  runEventLoggerOnce,
  startEventLoggerWorker,
  stopEventLoggerWorker
} from '../../workers/event-logger.worker';

function createQueuedRecord(index: number): string {
  return JSON.stringify({
    eventId: `EVT-${index}`,
    eventType: 'DONATION_CONFIRMED',
    projectId: 'project-1',
    timestamp: '2026-08-16T00:00:00.000Z',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    amount: 100,
    correlationId: `donation:${index}`,
    organizationId: 'org-1',
    payload: { transactionHash: `0xtx-${index}`, blockNumber: index, isAnonymous: false },
    source: 'api',
    archiveState: 'HOT',
    archivedAt: null,
    archiveLocator: null,
    archiveChecksum: null,
    createdAt: null
  });
}

describe('event-logger.worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.redis = createRedisMock();
    mocks.redis.lLen.mockResolvedValue(0);
    mocks.redis.lRange.mockResolvedValue([]);
    mocks.redis.rename.mockResolvedValue('OK');
    mocks.redis.del.mockResolvedValue(1);
    mocks.insertMany.mockResolvedValue([]);
    process.env.EVENT_LOGGER_ENABLED = 'true';
    process.env.EVENT_LOGGER_BATCH_SIZE = '100';
    process.env.EVENT_LOGGER_FLUSH_INTERVAL_MS = '300000';
    process.env.EVENT_LOGGER_TICK_MS = '5000';
    __resetEventLoggerWorkerState();
  });

  afterEach(async () => {
    await stopEventLoggerWorker();
    vi.useRealTimers();
  });

  it('RENAME rồi insertMany toàn bộ batch 100 và xoá inflight sau khi ghi', async () => {
    mocks.redis!.lLen.mockResolvedValueOnce(100).mockResolvedValue(0);
    mocks.redis!.lRange.mockResolvedValue(Array.from({ length: 100 }, (_, index) => createQueuedRecord(index)));

    await runEventLoggerOnce();

    expect(mocks.redis!.rename).toHaveBeenCalledWith('dcp:events:buffer', expect.stringMatching(/^dcp:events:inflight:/));
    expect(mocks.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ eventId: 'EVT-0', createdAt: expect.any(Date) })])
    );
    expect(mocks.redis!.del).toHaveBeenCalledTimes(1);
  });

  it('recovery inflight key đủ tuổi insert record và xoá key sau khi ghi thành công', async () => {
    const recoverableKey = `dcp:events:inflight:${Date.now() - 5 * 60 * 1_000}:recovery`;
    mocks.redis!.scanIterator.mockImplementation(async function* (): AsyncGenerator<string[], void, void> {
      yield [recoverableKey];
    });
    mocks.redis!.lRange.mockImplementation(async (key: string) => (
      key === recoverableKey ? [createQueuedRecord(99)] : []
    ));
    mocks.redis!.lLen.mockResolvedValue(0);

    await runEventLoggerOnce();

    expect(mocks.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'EVT-99', createdAt: expect.any(Date) })
    ]);
    expect(mocks.redis!.del).toHaveBeenCalledWith(recoverableKey);
    expect(mocks.redis!.rename).not.toHaveBeenCalled();
  });

  it('bỏ qua inflight key chưa đủ tuổi để tránh đụng batch đang được worker khác xử lý', async () => {
    const freshKey = `dcp:events:inflight:${Date.now() - 1_000}:fresh`;
    mocks.redis!.scanIterator.mockImplementation(async function* (): AsyncGenerator<string[], void, void> {
      yield [freshKey];
    });

    await runEventLoggerOnce();

    expect(mocks.redis!.lRange).not.toHaveBeenCalled();
    expect(mocks.redis!.del).not.toHaveBeenCalled();
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('5 event chưa flush trước 4 phút 30 giây nhưng được flush khi đủ 5 phút', async () => {
    mocks.redis!.lLen.mockResolvedValue(5);
    mocks.redis!.lRange.mockResolvedValue(Array.from({ length: 5 }, (_, index) => createQueuedRecord(index)));

    vi.setSystemTime(Date.now() + 4.5 * 60 * 1_000);
    await runEventLoggerOnce();
    expect(mocks.insertMany).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 30 * 1_000);
    await runEventLoggerOnce();
    expect(mocks.insertMany).toHaveBeenCalledTimes(1);
  });

  it('duplicate-only bulk error được coi là thành công để xoá inflight', async () => {
    mocks.redis!.lLen.mockResolvedValue(100);
    mocks.redis!.lRange.mockResolvedValue([createQueuedRecord(1)]);
    mocks.insertMany.mockRejectedValue({ writeErrors: [{ code: 11000 }] });

    await runEventLoggerOnce();

    expect(mocks.redis!.del).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('duplicate eventId'),
      expect.any(Object)
    );
  });

  it('stop worker clear timer và chờ lượt flush cuối', async () => {
    mocks.redis!.lLen.mockResolvedValue(0);
    startEventLoggerWorker();
    await Promise.resolve();
    await stopEventLoggerWorker();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('giữ inflight key khi record JSON không hợp lệ để retry', async () => {
    const recoverableKey = `dcp:events:inflight:${Date.now() - 5 * 60 * 1_000}:malformed`;
    mocks.redis!.scanIterator.mockImplementation(async function* (): AsyncGenerator<string[], void, void> {
      yield [recoverableKey];
    });
    mocks.redis!.lRange.mockResolvedValue([JSON.stringify({ eventId: 'EVT-MALFORMED' })]);

    await runEventLoggerOnce();

    expect(mocks.insertMany).not.toHaveBeenCalled();
    expect(mocks.redis!.del).not.toHaveBeenCalledWith(recoverableKey);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('recovery inflight'),
      expect.any(Object)
    );
  });

  it('giữ inflight key khi Mongo insert thất bại để retry an toàn', async () => {
    const recoverableKey = `dcp:events:inflight:${Date.now() - 5 * 60 * 1_000}:insert-failure`;
    mocks.redis!.scanIterator.mockImplementation(async function* (): AsyncGenerator<string[], void, void> {
      yield [recoverableKey];
    });
    mocks.redis!.lRange.mockResolvedValue([createQueuedRecord(100)]);
    mocks.insertMany.mockRejectedValue(new Error('Mongo unavailable'));

    await runEventLoggerOnce();

    expect(mocks.redis!.del).not.toHaveBeenCalledWith(recoverableKey);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('recovery inflight'),
      expect.any(Object)
    );
  });
});
