import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queue: {
    getJob: vi.fn(),
    add: vi.fn()
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('bull', () => ({
  default: vi.fn().mockImplementation(() => mocks.queue)
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn().mockReturnValue({ options: { url: 'redis://localhost:6379' } })
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

vi.mock('../../utils/extractErrorMessage', () => ({
  extractErrorMessage: vi.fn(() => 'mock error')
}));

import { enqueueSbtMint } from '../sbtMintQueue';

describe('sbtMintQueue terminal job handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queue.getJob.mockResolvedValue(null);
    mocks.queue.add.mockResolvedValue({ id: 'new-job' });
  });

  it('removes a completed deterministic job before durable replay adds a fresh job', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.queue.getJob.mockResolvedValue({
      id: 'old-job',
      getState: vi.fn().mockResolvedValue('completed'),
      remove
    });

    const result = await enqueueSbtMint({
      mintRequestId: 'MINT-1',
      sbtId: 'SBT-1',
      attemptNumber: 1,
      enqueuedBy: 'oracle_event'
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.queue.add).toHaveBeenCalledWith(
      expect.objectContaining({ mintRequestId: 'MINT-1', attemptNumber: 1 }),
      expect.objectContaining({ jobId: 'MINT-1-attempt1' })
    );
    expect(result).toEqual({ jobId: 'new-job', enqueued: true });
  });

  it('treats an active deterministic job as already dispatched without duplicating it', async () => {
    mocks.queue.getJob.mockResolvedValue({
      id: 'active-job',
      getState: vi.fn().mockResolvedValue('active'),
      remove: vi.fn()
    });

    const result = await enqueueSbtMint({
      mintRequestId: 'MINT-2',
      sbtId: 'SBT-2',
      attemptNumber: 2,
      enqueuedBy: 'cron_recovery'
    });

    expect(mocks.queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'active-job', enqueued: true });
  });
});
