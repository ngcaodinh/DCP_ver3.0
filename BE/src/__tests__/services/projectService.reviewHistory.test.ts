import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const { mockFindProjectsByStatusList, mockFindUserById } = vi.hoisted(() => ({
  mockFindProjectsByStatusList: vi.fn(),
  mockFindUserById: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}));

vi.mock('../../models/authModel', () => ({
  findUserById: mockFindUserById
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionsByOrganizationId: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  countActiveProjectsByOrganizationIdFromRepository: vi.fn(),
  createProject: vi.fn(),
  findProjectById: vi.fn(),
  findProjectByOrganizationAndName: vi.fn(),
  findProjectsByOrganizationIdFromRepository: vi.fn(),
  findProjectsByStatusFromRepository: vi.fn(),
  findProjectsByStatusListFromRepository: mockFindProjectsByStatusList,
  findPublicSupportProjectDetailFromRepository: vi.fn(),
  findPublicSupportProjectsFromRepository: vi.fn(),
  updateProject: vi.fn()
}));

vi.mock('../../repositories/donationRepository', () => ({
  findLatestDonationTimestampByProjectIdFromRepository: vi.fn()
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({ deleteByKey: vi.fn(), get: vi.fn(), set: vi.fn() }))
}));

import { getProjectReviewHistoryForReviewer } from '../../services/projectService';

/** Hàm tạo dự án đã review để kiểm tra Regulatory nhận đầy đủ trạng thái lịch sử. */
function createProjectFixture(status: ProjectRecord['status']): ProjectRecord {
  const createdAt = new Date('2026-08-18T00:00:00.000Z');
  return {
    projectId: `2026081800000000${status === 'ACTIVE' ? '01' : '02'}`,
    organizationId: 'organization-1',
    name: `Project ${status}`,
    description: 'Dự án kiểm thử lịch sử review.',
    goalAmount: 50_000_000,
    deadline: new Date('2026-12-31T00:00:00.000Z'),
    status,
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: createdAt,
    reviewedAt: status === 'PENDING_APPROVAL' ? null : createdAt,
    reviewedBy: status === 'PENDING_APPROVAL' ? null : 'regulatory-1',
    rejectionReason: status === 'REJECTED' ? 'Không đáp ứng tiêu chí hỗ trợ.' : null,
    createdAt,
    updatedAt: createdAt
  };
}

describe('project service review history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserById.mockResolvedValue({ id: 'regulatory-1', role: 'regulatory' });
  });

  it('returns every governance lifecycle status for a regulatory reviewer', async () => {
    mockFindProjectsByStatusList.mockResolvedValue([
      createProjectFixture('PENDING_APPROVAL'),
      createProjectFixture('PENDING_ACTIVATION'),
      createProjectFixture('DISPUTED'),
      createProjectFixture('ACTIVE'),
      createProjectFixture('REJECTED')
    ]);

    await expect(getProjectReviewHistoryForReviewer('regulatory-1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PENDING_APPROVAL' }),
      expect.objectContaining({ status: 'PENDING_ACTIVATION' }),
      expect.objectContaining({ status: 'DISPUTED' }),
      expect.objectContaining({ status: 'ACTIVE' }),
      expect.objectContaining({ rejectionReason: 'Không đáp ứng tiêu chí hỗ trợ.', status: 'REJECTED' })
    ]));
    expect(mockFindProjectsByStatusList).toHaveBeenCalledWith(['PENDING_APPROVAL', 'PENDING_ACTIVATION', 'DISPUTED', 'ACTIVE', 'REJECTED']);
  });

  it('rejects an administrator because only regulatory may review projects', async () => {
    mockFindUserById.mockResolvedValue({ id: 'admin-1', role: 'admin' });

    await expect(getProjectReviewHistoryForReviewer('admin-1')).rejects.toMatchObject({
      errorCode: 'FORBIDDEN', statusCode: 403
    });
    expect(mockFindProjectsByStatusList).not.toHaveBeenCalled();
  });

  it('rejects callers without reviewer permissions before loading history', async () => {
    mockFindUserById.mockResolvedValue({ id: 'donor-1', role: 'donor' });

    await expect(getProjectReviewHistoryForReviewer('donor-1')).rejects.toMatchObject({
      errorCode: 'FORBIDDEN',
      statusCode: 403
    });
    expect(mockFindProjectsByStatusList).not.toHaveBeenCalled();
  });
});
