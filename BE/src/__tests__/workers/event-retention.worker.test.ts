import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  purge: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../services/event-archive.service', () => ({
  archiveProjectEvents: mocks.archive,
  purgeArchivedRegularEvents: mocks.purge,
  createConfiguredEventArchiveStore: vi.fn(() => null)
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  runEventRetentionOnce,
  startEventRetentionWorker,
  stopEventRetentionWorker
} from '../../workers/event-retention.worker';

const archiveResult = {
  regularCutoff: new Date(),
  immutableCutoff: new Date(),
  scanned: 0,
  archived: 0,
  skipped: 0,
  failed: 0,
  hasMore: false,
  oldestHotTimestamp: null,
  backlogAgeMs: null
};
const purgeResult = { cutoff: new Date(), scanned: 0, deleted: 0, failed: 0, hasMore: false };

describe('event-retention.worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    process.env.EVENT_ARCHIVE_ENABLED = 'false';
    mocks.archive.mockResolvedValue(archiveResult);
    mocks.purge.mockResolvedValue(purgeResult);
  });

  afterEach(() => {
    stopEventRetentionWorker();
    vi.useRealTimers();
  });

  it('không khởi động khi EVENT_ARCHIVE_ENABLED khác true', () => {
    startEventRetentionWorker({} as never);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_ARCHIVE_ENABLED'));
  });

  it('chạy archive và purge trong worker context khi được bật', async () => {
    process.env.EVENT_ARCHIVE_ENABLED = 'true';
    const store = {} as never;
    await runEventRetentionOnce(store);

    expect(mocks.archive).toHaveBeenCalledWith({ store, maxBatches: 100, timeBudgetMs: 30_000 });
    expect(mocks.purge).toHaveBeenCalledWith({ store, maxBatches: 100, timeBudgetMs: 30_000 });
  });

  it('fail-closed khi archive bật nhưng cold storage chưa cấu hình', () => {
    process.env.EVENT_ARCHIVE_ENABLED = 'true';
    startEventRetentionWorker();

    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('thiếu cấu hình cold storage')
    );
  });

  it('dừng interval và drain timeout sạch khi worker shutdown', async () => {
    process.env.EVENT_ARCHIVE_ENABLED = 'true';
    mocks.archive.mockResolvedValue({ ...archiveResult, hasMore: true });
    startEventRetentionWorker({} as never);
    await vi.runOnlyPendingTimersAsync();
    stopEventRetentionWorker();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
