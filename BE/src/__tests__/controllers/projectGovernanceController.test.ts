import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

const { mockFindFieldReport, mockFindFieldReports, mockFindProjectsByStatus, mockFindProjectsByIds, mockFindChallengeRounds, mockFindChallengeCounts, mockFindPendingArbitrations, mockFindUsersByIds } = vi.hoisted(() => ({
  mockFindFieldReport: vi.fn(),
  mockFindFieldReports: vi.fn(),
  mockFindProjectsByStatus: vi.fn(),
  mockFindProjectsByIds: vi.fn(),
  mockFindChallengeRounds: vi.fn(),
  mockFindChallengeCounts: vi.fn(),
  mockFindPendingArbitrations: vi.fn(),
  mockFindUsersByIds: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findUserById: vi.fn(), findUsersByIds: mockFindUsersByIds }));
vi.mock('../../services/projectService', () => ({ updateProjectMilestonePlanForOrganization: vi.fn() }));
vi.mock('../../services/projectChallenge.service', () => ({ submitProjectChallenge: vi.fn() }));
vi.mock('../../services/projectActivation.service', () => ({ retryFailedProjectActivation: vi.fn() }));
vi.mock('../../services/projectArbitration.service', () => ({ voteOnArbitration: vi.fn() }));
vi.mock('../../services/auditorFieldReport.service', () => ({ submitAuditorFieldReport: vi.fn() }));
vi.mock('../../repositories/auditorFieldReportRepository', () => ({ findAuditorFieldReportByProjectIdFromRepository: mockFindFieldReport, findAuditorFieldReportsByProjectIdsFromRepository: mockFindFieldReports }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ countProjectChallengesByProjectRoundFromRepository: mockFindChallengeCounts, findProjectChallengesFromRepository: vi.fn(), findProjectChallengeProjectRoundsByUserFromRepository: mockFindChallengeRounds }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: vi.fn(), findProjectsByIdList: mockFindProjectsByIds, findProjectsByStatusFromRepository: mockFindProjectsByStatus }));
vi.mock('../../repositories/projectArbitrationRepository', () => ({ findProjectArbitrationByIdFromRepository: vi.fn(), findPendingProjectArbitrationsFromRepository: mockFindPendingArbitrations }));
vi.mock('../../models/projectArbitrationModel', () => ({ ProjectArbitrationMongoModel: {} }));

import { handleGetAuditorActiveProjects, handleGetAuditorFieldReport, handleGetAuditorPendingProjects, handleGetExecutiveCases } from '../../controllers/projectGovernanceController';

/** Tạo request Auditor tối thiểu để kiểm thử quyền sở hữu biên bản có GPS. */
function createRequest(userId = 'auditor-owner'): AuthenticatedRequest {
  return { query: { projectId: 'project-1' }, authenticatedUser: { userId, role: 'auditor' } } as unknown as AuthenticatedRequest;
}

/** Tạo Response chain giống Express để kiểm tra envelope chuẩn. */
function createResponse(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

describe('project governance controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFieldReports.mockResolvedValue([]);
    mockFindUsersByIds.mockResolvedValue([]);
    mockFindChallengeRounds.mockResolvedValue([]);
    mockFindChallengeCounts.mockResolvedValue([]);
    mockFindProjectsByIds.mockResolvedValue([]);
    mockFindPendingArbitrations.mockResolvedValue([]);
  });

  it('rejects a different auditor before returning report GPS and photo metadata', async () => {
    mockFindFieldReport.mockResolvedValue({ reportId: 'report-1', auditorUserId: 'auditor-owner', photos: [{ gps: { lat: 10, lng: 106 } }] });
    const response = createResponse();

    await handleGetAuditorFieldReport(createRequest('auditor-other'), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'FORBIDDEN' }));
  });

  it('returns the full report only to the auditor who submitted it', async () => {
    const report = { reportId: 'report-1', auditorUserId: 'auditor-owner', photos: [{ gps: { lat: 10, lng: 106 } }] };
    mockFindFieldReport.mockResolvedValue(report);
    const response = createResponse();

    await handleGetAuditorFieldReport(createRequest(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: report }));
  });

  it('loads active-project reports and organizations in two batches instead of N+1 queries', async () => {
    mockFindProjectsByStatus.mockResolvedValueOnce([
      { projectId: 'project-1', organizationId: 'org-1', name: 'Một', milestonePlan: [] },
      { projectId: 'project-2', organizationId: 'org-2', name: 'Hai', milestonePlan: [] }
    ]);
    mockFindFieldReports.mockResolvedValue([{ projectId: 'project-1', reportId: 'report-1', auditorUserId: 'auditor-owner', verifiedMilestoneIndexes: [1], submittedAt: new Date() }]);
    mockFindUsersByIds.mockResolvedValue([{ id: 'org-1', organizationName: 'Tổ chức Một' }]);
    const response = createResponse();

    await handleGetAuditorActiveProjects(createRequest(), response);

    expect(mockFindFieldReports).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(mockFindUsersByIds).toHaveBeenCalledWith(['org-1', 'org-2']);
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('builds pending-project challenge flags from one batch query per auditor', async () => {
    mockFindProjectsByStatus.mockResolvedValueOnce([{ projectId: 'project-1', listingRound: 1, name: 'Một', description: 'Mô tả', status: 'PENDING_ACTIVATION', listedAt: null, activationEligibleAt: null, milestonePlan: [], evidenceCids: [] }]);
    mockFindProjectsByStatus.mockResolvedValueOnce([{ projectId: 'project-2', listingRound: 2, name: 'Hai', description: 'Mô tả', status: 'DISPUTED', listedAt: null, activationEligibleAt: null, milestonePlan: [], evidenceCids: [] }]);
    mockFindChallengeRounds.mockResolvedValue([{ projectId: 'project-2', round: 2 }]);
    const response = createResponse();

    await handleGetAuditorPendingProjects(createRequest(), response);

    expect(mockFindChallengeRounds).toHaveBeenCalledWith('auditor-owner', ['project-1', 'project-2']);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ projectId: 'project-2', hasCurrentUserChallenged: true })]) }));
  });

  it('builds executive case summaries through batch project, organization, and challenge queries', async () => {
    mockFindPendingArbitrations.mockResolvedValue([{ arbitrationId: 'case-1', projectId: 'project-1', round: 1, votes: [], committeeSnapshot: [], requiredMemberVotes: 2, openedAt: new Date(), deadlineAt: new Date() }]);
    mockFindProjectsByIds.mockResolvedValue([{ projectId: 'project-1', organizationId: 'org-1', name: 'Dự án Một' }]);
    mockFindUsersByIds.mockResolvedValue([{ id: 'org-1', organizationName: 'Tổ chức Một' }]);
    mockFindChallengeCounts.mockResolvedValue([{ projectId: 'project-1', round: 1, count: 3 }]);
    const response = createResponse();

    await handleGetExecutiveCases(createRequest('member-1'), response);

    expect(mockFindProjectsByIds).toHaveBeenCalledWith(['project-1']);
    expect(mockFindUsersByIds).toHaveBeenCalledWith(['org-1']);
    expect(mockFindChallengeCounts).toHaveBeenCalledWith(['project-1']);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ challengeCount: 3 })] }));
  });
});
