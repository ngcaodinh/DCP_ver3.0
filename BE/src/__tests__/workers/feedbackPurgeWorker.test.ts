import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../services/feedbackPurge.service', () => ({ purgeSoftDeletedFeedback: mocks.purge }));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  runFeedbackPurgeOnce,
  startFeedbackPurgeWorker,
  stopFeedbackPurgeWorker
} from '../../workers/feedbackPurgeWorker';

const emptyResult = {
  cutoff: new Date('2026-07-16T00:00:00.000Z'),
  scanned: 0,
  purged: 0,
  hasMore: false,
  oldestDeletedAt: null,
  affectedProjectIds: []
};

describe('feedbackPurgeWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.FEEDBACK_PURGE_ENABLED;
    mocks.purge.mockResolvedValue(emptyResult);
  });

  afterEach(() => {
    stopFeedbackPurgeWorker();
    vi.useRealTimers();
  });

  it('không khởi động nếu chưa bật env và chạy một vòng bounded khi bật', async () => {
    startFeedbackPurgeWorker();
    expect(mocks.purge).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Feedback purge worker chưa bật'));

    process.env.FEEDBACK_PURGE_ENABLED = 'true';
    await runFeedbackPurgeOnce();
    expect(mocks.purge).toHaveBeenCalledWith({ maxBatches: 100, timeBudgetMs: 30_000 });
  });

  it('không chạy chồng và hẹn drain sau 60 giây khi hasMore', async () => {
    process.env.FEEDBACK_PURGE_ENABLED = 'true';
    let resolvePurge: ((value: typeof emptyResult) => void) | undefined;
    mocks.purge.mockReturnValue(new Promise(resolve => { resolvePurge = resolve; }));
    startFeedbackPurgeWorker();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(mocks.purge).toHaveBeenCalledTimes(1);

    resolvePurge?.({ ...emptyResult, hasMore: true });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.purge).toHaveBeenCalledTimes(2);
  });

  it('huỷ drain timeout khi worker dừng', async () => {
    process.env.FEEDBACK_PURGE_ENABLED = 'true';
    mocks.purge.mockResolvedValue({ ...emptyResult, hasMore: true });
    startFeedbackPurgeWorker();
    await Promise.resolve();
    await Promise.resolve();

    stopFeedbackPurgeWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.purge).toHaveBeenCalledTimes(1);
  });
});
