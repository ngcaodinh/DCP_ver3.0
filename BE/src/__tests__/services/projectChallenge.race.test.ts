import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const { mockAcquireCase, mockCleanupPhotos, mockCreateChallenge, mockCreateRegistry, mockFindChallenge, mockFindProject, mockOpenCase, mockProcessPhotos, mockQuota, mockReleaseCase, mockUpdateIfStatus } = vi.hoisted(() => ({
  mockAcquireCase: vi.fn(),
  mockCreateChallenge: vi.fn(), mockCreateRegistry: vi.fn(), mockFindChallenge: vi.fn(), mockFindProject: vi.fn(),
  mockOpenCase: vi.fn(), mockCleanupPhotos: vi.fn(), mockProcessPhotos: vi.fn(() => Promise.resolve([])), mockQuota: vi.fn(), mockReleaseCase: vi.fn(), mockUpdateIfStatus: vi.fn()
}));

vi.mock('../../utils/mongoTransaction', () => ({ runMongoTransaction: async (work: (session: undefined) => unknown) => work(undefined) }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mockFindProject, updateProjectIfStatus: mockUpdateIfStatus }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ createProjectChallengeFromRepository: mockCreateChallenge, findChallengeByProjectRoundAndUser: mockFindChallenge, countProjectChallengesByUserSinceFromRepository: mockQuota }));
vi.mock('../../repositories/evidencePhotoRegistryRepository', () => ({ createEvidencePhotoRegistryRecordsFromRepository: mockCreateRegistry }));
vi.mock('../../services/evidencePhotoCapture.service', () => ({ processCapturedEvidencePhotos: mockProcessPhotos, cleanupCapturedEvidencePhotos: mockCleanupPhotos }));
vi.mock('../../services/projectArbitration.service', () => ({ openArbitrationCase: mockOpenCase }));
vi.mock('../../models/projectArbitrationModel', () => ({ ProjectArbitrationMongoModel: {} }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ acquireAuditorOpenCase: mockAcquireCase, initializeAuditorStakeGuard: vi.fn(), releaseAuditorOpenCase: mockReleaseCase }));

import { submitProjectChallenge } from '../../services/projectChallenge.service';

/** Tạo fixture dự án đang cho phép nhận khiếu nại. */
function pendingProject(): ProjectRecord {
  const now = new Date();
  return { projectId: 'project-race', organizationId: 'org-1', name: 'Dự án race', description: 'Mô tả hợp lệ', goalAmount: 1, deadline: now, status: 'PENDING_ACTIVATION', evidenceCids: [], evidenceFiles: [], submittedAt: now, reviewedAt: now, reviewedBy: 'regulatory-1', rejectionReason: null, listingRound: 1, createdAt: now, updatedAt: now };
}

describe('project challenge duplicate-submission race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindChallenge.mockResolvedValue(false);
    mockQuota.mockResolvedValue(0);
    mockFindProject.mockResolvedValue(pendingProject());
    mockCreateChallenge.mockResolvedValue({ challengeId: 'challenge-race' });
    mockCreateRegistry.mockResolvedValue(undefined);
    mockUpdateIfStatus.mockResolvedValue(pendingProject());
    mockOpenCase.mockResolvedValue({ arbitrationId: 'arbitration-race' });
    mockAcquireCase.mockResolvedValue({ auditorUserId: 'auditor-1' });
  });

  it('maps challenge unique-index collision to DUPLICATE_SUBMISSION', async () => {
    mockCreateChallenge.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 11000 }));
    await expect(submitProjectChallenge('auditor-1', { projectId: 'project-race', reason: 'Khiếu nại đã được gửi đồng thời từ cùng tài khoản.' })).rejects.toMatchObject({ statusCode: 409, errorCode: 'DUPLICATE_SUBMISSION' });
    expect(mockUpdateIfStatus).not.toHaveBeenCalled();
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it('maps registry unique-index collision to DUPLICATE_EVIDENCE_PHOTO', async () => {
    mockCreateRegistry.mockRejectedValueOnce(Object.assign(new Error('duplicate photo'), { code: 11000, writeErrors: [{ err: { keyPattern: { contentSha256: 1 } } }] }));
    await expect(submitProjectChallenge('auditor-1', { projectId: 'project-race', reason: 'Ảnh này vừa được một yêu cầu khác sử dụng.' })).rejects.toMatchObject({ statusCode: 409, errorCode: 'DUPLICATE_EVIDENCE_PHOTO' });
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it('keeps the unique tuple scoped to auditor, project and listing round', async () => {
    await expect(submitProjectChallenge('auditor-2', { projectId: 'project-race', reason: 'Auditor khác vẫn được quyền gửi khiếu nại trong cùng vòng.' })).resolves.toMatchObject({ arbitrationId: 'arbitration-race', projectStatus: 'DISPUTED' });
    expect(mockCreateChallenge).toHaveBeenCalledWith(expect.objectContaining({ challengerUserId: 'auditor-2', projectId: 'project-race', round: 1 }), undefined);
  });
});
