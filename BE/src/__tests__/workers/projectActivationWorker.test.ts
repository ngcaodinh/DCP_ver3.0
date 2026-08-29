import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockActivate, mockClose, mockFindClosure, mockFindOverdue, mockFindReady, mockResolve } = vi.hoisted(() => ({ mockActivate: vi.fn(), mockClose: vi.fn(), mockFindClosure: vi.fn(), mockFindOverdue: vi.fn(), mockFindReady: vi.fn(), mockResolve: vi.fn() }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: vi.fn() }) }));
vi.mock('../../config/requestContext', () => ({ runWithWorkerContext: async (_name: string, work: () => unknown) => work() }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectsReadyForActivationFromRepository: mockFindReady, findRejectedProjectsNeedingClosureFromRepository: mockFindClosure }));
vi.mock('../../repositories/projectArbitrationRepository', () => ({ findPendingArbitrationsExpiredBeforeFromRepository: mockFindOverdue }));
vi.mock('../../services/projectActivation.service', () => ({ activateApprovedProject: mockActivate }));
vi.mock('../../services/projectClosure.service', () => ({ closeRejectedProject: mockClose }));
vi.mock('../../services/projectArbitration.service', () => ({ resolveArbitrationByTimeout: mockResolve }));

import { runProjectActivationCycle } from '../../workers/projectActivationWorker';

describe('project activation worker', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFindReady.mockResolvedValue([]); mockFindClosure.mockResolvedValue([]); mockFindOverdue.mockResolvedValue([]); });

  it('activates only repository-selected ready projects and resolves overdue cases', async () => {
    mockFindReady.mockResolvedValue([{ projectId: 'ready-1' }]);
    mockFindClosure.mockResolvedValue([{ projectId: 'close-1' }]);
    mockFindOverdue.mockResolvedValue([{ arbitrationId: 'case-1' }]);
    await runProjectActivationCycle();
    expect(mockActivate).toHaveBeenCalledWith('ready-1', 'PENDING_ACTIVATION');
    expect(mockClose).toHaveBeenCalledWith('close-1');
    expect(mockResolve).toHaveBeenCalledWith('case-1');
  });

  it('continues processing later projects after an activation error', async () => {
    mockFindReady.mockResolvedValue([{ projectId: 'broken' }, { projectId: 'next' }]);
    mockActivate.mockRejectedValueOnce(new Error('RPC failure')).mockResolvedValueOnce('ACTIVATED');
    await expect(runProjectActivationCycle()).resolves.toBeUndefined();
    expect(mockActivate).toHaveBeenCalledWith('next', 'PENDING_ACTIVATION');
  });

  it('cô lập lỗi đóng chain và timeout để bản ghi sau trong từng hàng đợi vẫn được xử lý', async () => {
    mockFindClosure.mockResolvedValue([{ projectId: 'close-broken' }, { projectId: 'close-next' }]);
    mockFindOverdue.mockResolvedValue([{ arbitrationId: 'timeout-broken' }, { arbitrationId: 'timeout-next' }]);
    mockClose.mockRejectedValueOnce(new Error('close RPC failure')).mockResolvedValueOnce('CLOSED');
    mockResolve.mockRejectedValueOnce(new Error('timeout persistence failure')).mockResolvedValueOnce(null);

    await expect(runProjectActivationCycle()).resolves.toBeUndefined();

    expect(mockClose).toHaveBeenCalledWith('close-next');
    expect(mockResolve).toHaveBeenCalledWith('timeout-next');
  });

  it('passes one bounded batch limit to both queries', async () => {
    await runProjectActivationCycle();
    expect(mockFindReady.mock.calls[0][1]).toBe(50);
    expect(mockFindClosure.mock.calls[0][1]).toBe(50);
    expect(mockFindOverdue.mock.calls[0][1]).toBe(50);
  });
});
