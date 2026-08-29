import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimProjectForClosure: vi.fn(),
  updateProject: vi.fn(),
  closeProjectOnBlockchain: vi.fn(),
  loggerError: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  claimProjectForClosureFromRepository: mocks.claimProjectForClosure,
  updateProject: mocks.updateProject
}));
vi.mock('../../services/projectService', () => ({ closeProjectOnBlockchain: mocks.closeProjectOnBlockchain }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: mocks.loggerError }) }));

import { closeRejectedProject } from '../../services/projectClosure.service';

describe('project closure service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimProjectForClosure.mockResolvedValue({ projectId: 'project-1', closureAttemptCount: 0, closureClaimedAt: new Date('2026-08-29T00:00:00.000Z') });
    mocks.updateProject.mockResolvedValue({ projectId: 'project-1' });
  });

  it('đóng on-chain một lần sau khi claim thành công và đánh dấu SYNCED', async () => {
    mocks.closeProjectOnBlockchain.mockResolvedValue(undefined);

    await expect(closeRejectedProject('project-1')).resolves.toBe('CLOSED');

    expect(mocks.closeProjectOnBlockchain).toHaveBeenCalledWith('project-1');
    expect(mocks.updateProject).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      closureState: 'SYNCED', closureClaimedAt: null, closureNextAttemptAt: null, closureLastError: null
    }));
  });

  it('không gửi giao dịch khi một worker khác đang sở hữu lease đóng', async () => {
    mocks.claimProjectForClosure.mockResolvedValue(null);

    await expect(closeRejectedProject('project-1')).resolves.toBe('ALREADY_CLAIMED');

    expect(mocks.closeProjectOnBlockchain).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('lưu FAILED và backoff khi RPC đóng dự án lỗi để worker retry an toàn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'));
    mocks.closeProjectOnBlockchain.mockRejectedValue(new Error('RPC unavailable'));

    await expect(closeRejectedProject('project-1')).resolves.toBe('FAILED');

    expect(mocks.updateProject).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      closureState: 'FAILED', closureClaimedAt: null, closureNextAttemptAt: new Date('2026-08-29T00:10:00.000Z'), closureLastError: 'RPC unavailable'
    }));
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('đã lên lịch retry'), expect.objectContaining({ projectId: 'project-1', attemptCount: 1 }));
    vi.useRealTimers();
  });

  it('không làm rò dữ liệu lỗi không phải Error và vẫn đưa vào hàng retry', async () => {
    mocks.closeProjectOnBlockchain.mockRejectedValue({ provider: 'unavailable' });

    await expect(closeRejectedProject('project-1')).resolves.toBe('FAILED');

    expect(mocks.updateProject).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      closureState: 'FAILED', closureLastError: 'Không thể đóng dự án trên blockchain.'
    }));
  });
});
