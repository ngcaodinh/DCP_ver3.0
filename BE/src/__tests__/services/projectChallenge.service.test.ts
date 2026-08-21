import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const { mockCreateChallenge, mockFindChallenge, mockFindProject, mockFindOne, mockOpenCase, mockProcessPhotos, mockQuota, mockUpdateIfStatus } = vi.hoisted(() => ({
  mockCreateChallenge: vi.fn(), mockFindChallenge: vi.fn(), mockFindProject: vi.fn(), mockFindOne: vi.fn(),
  mockOpenCase: vi.fn(), mockProcessPhotos: vi.fn(() => Promise.resolve([])), mockQuota: vi.fn(), mockUpdateIfStatus: vi.fn()
}));

vi.mock('../../utils/mongoTransaction', () => ({ runMongoTransaction: async (work: (session: undefined) => unknown) => work(undefined) }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mockFindProject, updateProjectIfStatus: mockUpdateIfStatus }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ createProjectChallengeFromRepository: mockCreateChallenge, findChallengeByProjectRoundAndUser: mockFindChallenge, countProjectChallengesByUserSinceFromRepository: mockQuota }));
vi.mock('../../repositories/evidencePhotoRegistryRepository', () => ({ createEvidencePhotoRegistryRecordsFromRepository: vi.fn() }));
vi.mock('../../services/evidencePhotoCapture.service', () => ({ processCapturedEvidencePhotos: mockProcessPhotos }));
vi.mock('../../services/projectArbitration.service', () => ({ openArbitrationCase: mockOpenCase }));
vi.mock('../../models/projectArbitrationModel', () => ({ ProjectArbitrationMongoModel: { findOne: mockFindOne } }));

import { submitProjectChallenge } from '../../services/projectChallenge.service';

/** Tạo fixture chỉ gồm dữ liệu quyết định trạng thái của challenge. */
function project(status: ProjectRecord['status'], overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date();
  return { projectId: 'project-1', organizationId: 'org-1', name: 'Dự án', description: 'Mô tả hợp lệ', goalAmount: 1, deadline: now, status, evidenceCids: [], evidenceFiles: [], submittedAt: now, reviewedAt: now, reviewedBy: 'regulatory-1', rejectionReason: null, listingRound: 1, createdAt: now, updatedAt: now, ...overrides };
}

describe('project challenge service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindChallenge.mockResolvedValue(false);
    mockQuota.mockResolvedValue(0);
    mockCreateChallenge.mockResolvedValue({ challengeId: 'challenge-1' });
    mockUpdateIfStatus.mockResolvedValue(project('DISPUTED'));
    mockOpenCase.mockResolvedValue({ arbitrationId: 'case-1' });
  });

  it('closes the challenge window after a project is ACTIVE', async () => {
    mockFindProject.mockResolvedValue(project('ACTIVE'));
    await expect(submitProjectChallenge('auditor-1', { projectId: 'project-1', reason: 'Lý do khiếu nại dài và hợp lệ.' })).rejects.toMatchObject({ errorCode: 'CHALLENGE_WINDOW_CLOSED' });
    expect(mockCreateChallenge).not.toHaveBeenCalled();
  });

  it('closes the challenge window when activation is overdue before the worker runs', async () => {
    const serverReceivedAt = new Date('2026-08-20T10:00:00.000Z');
    mockFindProject.mockResolvedValue(project('PENDING_ACTIVATION', {
      activationEligibleAt: new Date(serverReceivedAt.getTime() - 1)
    }));

    await expect(submitProjectChallenge('auditor-1', {
      projectId: 'project-1', reason: 'Lý do khiếu nại dài và hợp lệ.', serverReceivedAt
    })).rejects.toMatchObject({ errorCode: 'CHALLENGE_WINDOW_CLOSED' });
    expect(mockCreateChallenge).not.toHaveBeenCalled();
  });

  it('locks pending activation before opening exactly one arbitration case', async () => {
    mockFindProject.mockResolvedValue(project('PENDING_ACTIVATION'));
    await expect(submitProjectChallenge('auditor-1', { projectId: 'project-1', reason: 'Lý do khiếu nại dài và hợp lệ.' })).resolves.toMatchObject({ projectStatus: 'DISPUTED', arbitrationId: 'case-1' });
    expect(mockUpdateIfStatus).toHaveBeenCalledWith('project-1', 'PENDING_ACTIVATION', expect.objectContaining({ status: 'DISPUTED', activationEligibleAt: null }), undefined);
    expect(mockOpenCase).toHaveBeenCalledTimes(1);
  });

  it('refuses a second challenge if the disputed case was already resolved', async () => {
    mockFindProject.mockResolvedValue(project('DISPUTED'));
    mockFindOne.mockReturnValue({ session: () => ({ lean: () => ({ exec: async () => null }) }) });
    await expect(submitProjectChallenge('auditor-2', { projectId: 'project-1', reason: 'Lý do khiếu nại dài và hợp lệ.' })).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    expect(mockCreateChallenge).not.toHaveBeenCalled();
  });
});
