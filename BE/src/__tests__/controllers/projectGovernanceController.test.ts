import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

const { mockFindFieldReport, mockFindFieldReports, mockFindProjectsByStatus, mockFindProjectsByIds, mockFindProjectById, mockFindChallengeRounds, mockFindChallenges, mockFindChallengeCounts, mockFindPendingArbitrations, mockFindArbitrationById, mockFindUsersByIds, mockFindListingVerifications, mockFindGeofence, mockAggregateDonationSummary, mockVoteOnArbitration } = vi.hoisted(() => ({
  mockFindFieldReport: vi.fn(),
  mockFindFieldReports: vi.fn(),
  mockFindProjectsByStatus: vi.fn(),
  mockFindProjectsByIds: vi.fn(),
  mockFindProjectById: vi.fn(),
  mockFindChallengeRounds: vi.fn(),
  mockFindChallenges: vi.fn(),
  mockFindChallengeCounts: vi.fn(),
  mockFindPendingArbitrations: vi.fn(),
  mockFindArbitrationById: vi.fn(),
  mockFindUsersByIds: vi.fn(),
  mockFindListingVerifications: vi.fn(),
  mockFindGeofence: vi.fn(),
  mockAggregateDonationSummary: vi.fn(),
  mockVoteOnArbitration: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findUserById: vi.fn(), findUsersByIds: mockFindUsersByIds }));
vi.mock('../../services/projectService', () => ({ updateProjectMilestonePlanForOrganization: vi.fn() }));
vi.mock('../../services/projectChallenge.service', () => ({ submitProjectChallenge: vi.fn() }));
vi.mock('../../services/projectActivation.service', () => ({ retryFailedProjectActivation: vi.fn() }));
vi.mock('../../services/projectArbitration.service', () => ({ prepareArbitrationVoteSignature: vi.fn(), recoverDeadLetterProjectArbitrationOnChainDecision: vi.fn(), voteOnArbitration: mockVoteOnArbitration }));
vi.mock('../../services/auditorFieldReport.service', () => ({ submitAuditorFieldReport: vi.fn() }));
vi.mock('../../repositories/auditorFieldReportRepository', () => ({ findAuditorFieldReportByProjectIdFromRepository: mockFindFieldReport, findAuditorFieldReportsByProjectIdsFromRepository: mockFindFieldReports }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ countProjectChallengesByProjectRoundFromRepository: mockFindChallengeCounts, findProjectChallengesFromRepository: mockFindChallenges, findProjectChallengeProjectRoundsByUserFromRepository: mockFindChallengeRounds }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mockFindProjectById, findProjectsByIdList: mockFindProjectsByIds, findProjectsByStatusFromRepository: mockFindProjectsByStatus }));
vi.mock('../../repositories/projectArbitrationRepository', () => ({ findProjectArbitrationByIdFromRepository: mockFindArbitrationById, findPendingProjectArbitrationsFromRepository: mockFindPendingArbitrations }));
vi.mock('../../models/projectArbitrationModel', () => ({ ProjectArbitrationMongoModel: {} }));
vi.mock('../../models/auditorListingVerificationModel', () => ({ findListingVerificationsByAuditorUserId: mockFindListingVerifications }));
vi.mock('../../models/projectGeofenceModel', () => ({ findGeofenceByProjectId: mockFindGeofence }));
vi.mock('../../models/donationModel', () => ({ aggregateDonationSummaryByProjectId: mockAggregateDonationSummary }));

import { handleGetAuditorActiveProjects, handleGetAuditorFieldReport, handleGetAuditorPendingProjects, handleGetExecutiveCaseDetail, handleGetExecutiveCases, handleVoteOnArbitration } from '../../controllers/projectGovernanceController';

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
    mockFindArbitrationById.mockResolvedValue(null);
    mockFindProjectById.mockResolvedValue(null);
    mockFindChallenges.mockResolvedValue([]);
    mockFindListingVerifications.mockResolvedValue([]);
    mockFindGeofence.mockResolvedValue(null);
    mockAggregateDonationSummary.mockResolvedValue({ totalAmount: 0, donationCount: 0 });
    mockVoteOnArbitration.mockResolvedValue({ arbitrationId: 'case-1' });
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

  it('chuyển xác nhận rủi ro khóa tiền đã validate vào service bỏ phiếu', async () => {
    const response = createResponse();
    const request = {
      authenticatedUser: { userId: 'member-1', role: 'executive_member' },
      body: {
        arbitrationId: 'case-1', decision: 'REJECT_PROJECT', reason: 'Căn cứ xét xử đã được kiểm tra đầy đủ.',
        donationLockRiskAcknowledged: true
      }
    } as unknown as AuthenticatedRequest;

    await handleVoteOnArbitration(request, response);

    expect(mockVoteOnArbitration).toHaveBeenCalledWith('member-1', expect.objectContaining({
      decision: 'REJECT_PROJECT', markedAbusive: false, donationLockRiskAcknowledged: true
    }));
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('trả trạng thái và tổng tiền quyên góp chính xác cho dialog hủy dự án', async () => {
    mockFindArbitrationById.mockResolvedValue({
      arbitrationId: 'case-1', projectId: 'project-1', round: 1,
      committeeSnapshot: [{ userId: 'member-1', role: 'executive_member' }], votes: []
    });
    mockFindProjectById.mockResolvedValue({
      projectId: 'project-1', organizationId: 'organization-1', name: 'Dự án', description: 'Mô tả', status: 'ACTIVE',
      milestonePlan: [], evidenceCids: [], evidenceFiles: []
    });
    mockFindUsersByIds.mockResolvedValue([{ id: 'organization-1', organizationName: 'Tổ chức' }]);
    mockAggregateDonationSummary.mockResolvedValue({ totalAmount: 2_500_000, donationCount: 3 });
    const response = createResponse();

    await handleGetExecutiveCaseDetail({
      authenticatedUser: { userId: 'member-1', role: 'executive_member' }, params: { arbitrationId: 'case-1' }
    } as unknown as AuthenticatedRequest, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ project: expect.objectContaining({ status: 'ACTIVE', totalDonationAmount: 2_500_000 }) })
    }));
  });
});
