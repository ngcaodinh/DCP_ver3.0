import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const {
  mockFindGeofenceByProjectId,
  mockFindProjectById,
  mockFindUserById,
  mockUpdateProject
} = vi.hoisted(() => ({
  mockFindGeofenceByProjectId: vi.fn(),
  mockFindProjectById: vi.fn(),
  mockFindUserById: vi.fn(),
  mockUpdateProject: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}));

vi.mock('../../models/authModel', () => ({
  countActiveAuditors: vi.fn(),
  findUserById: mockFindUserById,
  findUsersByRole: vi.fn()
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionsByOrganizationId: vi.fn()
}));

vi.mock('../../models/projectGeofenceModel', () => ({
  findGeofenceByProjectId: mockFindGeofenceByProjectId,
  findProjectIdsWithGeofence: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  countActiveProjectsByOrganizationIdFromRepository: vi.fn(),
  createProject: vi.fn(),
  findProjectById: mockFindProjectById,
  findProjectByOrganizationAndName: vi.fn(),
  findProjectsByOrganizationIdFromRepository: vi.fn(),
  findProjectsByStatusFromRepository: vi.fn(),
  findProjectsByStatusListFromRepository: vi.fn(),
  findPublicSupportProjectDetailFromRepository: vi.fn(),
  findPublicSupportProjectsFromRepository: vi.fn(),
  updateProject: mockUpdateProject
}));

vi.mock('../../repositories/donationRepository', () => ({
  findLatestDonationTimestampByProjectIdFromRepository: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn()
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({ deleteByKey: vi.fn(), get: vi.fn(), set: vi.fn() }))
}));

import { submitProjectForApproval } from '../../services/projectService';

/** Tạo project DRAFT có đủ ba cột mốc để cô lập điều kiện geofence của luồng submit. */
function createDraftProjectFixture(): ProjectRecord {
  const now = new Date('2026-08-20T00:00:00.000Z');
  return {
    projectId: 'project-1',
    organizationId: 'organization-1',
    name: 'Dự án kiểm thử geofence',
    description: 'Dự án dùng để kiểm thử điều kiện thiết lập vùng địa lý.',
    goalAmount: 10_000_000,
    deadline: new Date('2026-12-31T00:00:00.000Z'),
    status: 'DRAFT',
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    milestonePlan: [
      { milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 25, description: 'Chuẩn bị hiện trường dự án.' },
      { milestoneIndex: 2, milestoneKey: 'M2_CONSTRUCTION', percentage: 45, description: 'Triển khai các hạng mục chính.' },
      { milestoneIndex: 3, milestoneKey: 'M3_HANDOVER', percentage: 30, description: 'Nghiệm thu và bàn giao dự án.' }
    ],
    createdAt: now,
    updatedAt: now
  };
}

describe('project service submit geofence requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserById.mockResolvedValue({ id: 'organization-1', role: 'organizations', accountStatus: 'ACTIVE' });
    mockFindProjectById.mockResolvedValue(createDraftProjectFixture());
    mockUpdateProject.mockImplementation(async (_projectId: string, update: Partial<ProjectRecord>) => ({
      ...createDraftProjectFixture(),
      ...update
    }));
  });

  it('từ chối submit khi project chưa lưu geofence', async () => {
    mockFindGeofenceByProjectId.mockResolvedValue(null);

    await expect(submitProjectForApproval('organization-user-1', 'project-1')).rejects.toMatchObject({
      errorCode: 'GEOFENCE_REQUIRED',
      statusCode: 409
    });
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it('cho phép submit sau khi geofence đã được lưu', async () => {
    mockFindGeofenceByProjectId.mockResolvedValue({ projectId: 'project-1' });

    await expect(submitProjectForApproval('organization-user-1', 'project-1')).resolves.toMatchObject({
      status: 'PENDING_APPROVAL',
      hasGeofence: true
    });
    expect(mockUpdateProject).toHaveBeenCalledWith('project-1', expect.objectContaining({ status: 'PENDING_APPROVAL' }));
  });
});
