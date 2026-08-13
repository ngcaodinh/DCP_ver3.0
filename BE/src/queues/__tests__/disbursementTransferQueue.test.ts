import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn()
}));

vi.mock('bull', () => ({
  default: vi.fn().mockImplementation(() => ({
    add: mocks.add,
    getJob: mocks.getJob
  }))
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => ({ options: { url: 'redis://localhost:6379' } }))
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

describe('disbursementTransferQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dùng deterministic jobId và coi job đã tồn tại là enqueue thành công', async () => {
    mocks.getJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-job' });
    mocks.add.mockResolvedValue({ id: 'created-job' });

    const { enqueueDisbursementTransfer, getDisbursementTransferJobId } = await import('../disbursementTransferQueue');
    const first = await enqueueDisbursementTransfer('request-1', 1, 'manual-key');
    const second = await enqueueDisbursementTransfer('request-1', 1, 'manual-key');

    expect(first).toEqual({ jobId: 'created-job', enqueued: true });
    expect(second).toEqual({ jobId: 'existing-job', enqueued: true });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-1', attemptNumber: 1, idempotencyKey: 'manual-key' }),
      expect.objectContaining({ jobId: getDisbursementTransferJobId('request-1', 1, 'manual-key') })
    );
  });
});
