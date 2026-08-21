import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockActivate, mockFindOverdue, mockFindReady, mockResolve } = vi.hoisted(() => ({ mockActivate: vi.fn(), mockFindOverdue: vi.fn(), mockFindReady: vi.fn(), mockResolve: vi.fn() }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: vi.fn() }) }));
vi.mock('../../config/requestContext', () => ({ runWithWorkerContext: async (_name: string, work: () => unknown) => work() }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectsReadyForActivationFromRepository: mockFindReady }));
vi.mock('../../repositories/projectArbitrationRepository', () => ({ findPendingArbitrationsExpiredBeforeFromRepository: mockFindOverdue }));
vi.mock('../../services/projectActivation.service', () => ({ activateApprovedProject: mockActivate }));
vi.mock('../../services/projectArbitration.service', () => ({ resolveArbitrationByTimeout: mockResolve }));

import { runProjectActivationCycle } from '../../workers/projectActivationWorker';

describe('project activation worker', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFindReady.mockResolvedValue([]); mockFindOverdue.mockResolvedValue([]); });

  it('activates only repository-selected ready projects and resolves overdue cases', async () => {
    mockFindReady.mockResolvedValue([{ projectId: 'ready-1' }]);
    mockFindOverdue.mockResolvedValue([{ arbitrationId: 'case-1' }]);
    await runProjectActivationCycle();
    expect(mockActivate).toHaveBeenCalledWith('ready-1', 'PENDING_ACTIVATION');
    expect(mockResolve).toHaveBeenCalledWith('case-1');
  });

  it('continues processing later projects after an activation error', async () => {
    mockFindReady.mockResolvedValue([{ projectId: 'broken' }, { projectId: 'next' }]);
    mockActivate.mockRejectedValueOnce(new Error('RPC failure')).mockResolvedValueOnce('ACTIVATED');
    await expect(runProjectActivationCycle()).resolves.toBeUndefined();
    expect(mockActivate).toHaveBeenCalledWith('next', 'PENDING_ACTIVATION');
  });

  it('passes one bounded batch limit to both queries', async () => {
    await runProjectActivationCycle();
    expect(mockFindReady.mock.calls[0][1]).toBe(50);
    expect(mockFindOverdue.mock.calls[0][1]).toBe(50);
  });
});
