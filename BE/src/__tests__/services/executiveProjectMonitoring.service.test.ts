import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countPendingDisbursementsByProjectIds: vi.fn(),
  countAuditorFieldReportsByProjectIds: vi.fn(),
  findAuditorFieldReportGeofenceMetadataByProjectIds: vi.fn(),
  findUsersByIds: vi.fn(),
  findDisbursementsByProjectIds: vi.fn(),
  findAuditorFieldReportsByProjectIds: vi.fn(),
  findGeofencesByProjectIds: vi.fn(),
  findLatestSubmissionsByOrganizationIds: vi.fn(),
  findDonationSummariesByProjectIds: vi.fn(),
  findExecutivePendingPublicationProjectsFromRepository: vi.fn(),
  findProjectById: vi.fn(),
  findPendingProjectArbitrationsByProjectRoundsFromRepository: vi.fn(),
  findProjectChallengesByProjectRoundsFromRepository: vi.fn(),
  findProjectChallengeReferencesByProjectRoundsFromRepository: vi.fn(),
  countListingVerificationsByProjectRounds: vi.fn(),
  findListingVerificationsByProjectRounds: vi.fn(),
  findProjectsByIdList: vi.fn(),
  findProjectsByStatusCursorFromRepository: vi.fn(),
  isPointInsidePolygon: vi.fn(),
  distanceFromPointToPolygonMeters: vi.fn(),
  haversineDistance: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findUsersByIds: mocks.findUsersByIds }));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementsByProjectIds: mocks.findDisbursementsByProjectIds,
  countPendingDisbursementsByProjectIds: mocks.countPendingDisbursementsByProjectIds
}));
vi.mock('../../models/auditorFieldReportModel', () => ({
  countAuditorFieldReportsByProjectIds: mocks.countAuditorFieldReportsByProjectIds,
  findAuditorFieldReportGeofenceMetadataByProjectIds: mocks.findAuditorFieldReportGeofenceMetadataByProjectIds,
  findAuditorFieldReportsByProjectIds: mocks.findAuditorFieldReportsByProjectIds
}));
vi.mock('../../models/projectGeofenceModel', () => ({ findGeofencesByProjectIds: mocks.findGeofencesByProjectIds }));
vi.mock('../../models/organizationKycModel', () => ({ findLatestSubmissionsByOrganizationIds: mocks.findLatestSubmissionsByOrganizationIds }));
vi.mock('../../repositories/donationRepository', () => ({ findDonationSummariesByProjectIds: mocks.findDonationSummariesByProjectIds }));
vi.mock('../../repositories/projectRepository', () => ({
  findExecutivePendingPublicationProjectsFromRepository: mocks.findExecutivePendingPublicationProjectsFromRepository,
  findProjectById: mocks.findProjectById,
  findProjectsByIdList: mocks.findProjectsByIdList,
  findProjectsByStatusCursorFromRepository: mocks.findProjectsByStatusCursorFromRepository
}));
vi.mock('../../repositories/projectArbitrationRepository', () => ({ findPendingProjectArbitrationsByProjectRoundsFromRepository: mocks.findPendingProjectArbitrationsByProjectRoundsFromRepository }));
vi.mock('../../repositories/projectChallengeRepository', () => ({
  findProjectChallengeReferencesByProjectRoundsFromRepository: mocks.findProjectChallengeReferencesByProjectRoundsFromRepository,
  findProjectChallengesByProjectRoundsFromRepository: mocks.findProjectChallengesByProjectRoundsFromRepository
}));
vi.mock('../../models/auditorListingVerificationModel', () => ({
  countListingVerificationsByProjectRounds: mocks.countListingVerificationsByProjectRounds,
  findListingVerificationsByProjectRounds: mocks.findListingVerificationsByProjectRounds
}));
vi.mock('../../utils/geoDistance', () => ({ isPointInsidePolygon: mocks.isPointInsidePolygon, distanceFromPointToPolygonMeters: mocks.distanceFromPointToPolygonMeters, haversineDistance: mocks.haversineDistance }));

import {
  buildExecutiveEvidencePhoto,
  getExecutivePendingPublicationProjectDetail,
  getExecutiveActiveProjectDetails,
  listExecutivePendingPublicationProjects,
  listExecutiveActiveProjects
} from '../../services/executiveProjectMonitoring.service';

/** Tạo ảnh biên bản tối thiểu để kiểm tra việc gom evidence theo nhiều report cùng dự án. */
function createFieldPhoto(cid: string): Record<string, unknown> {
  return {
    cid,
    gps: { latitude: 21, longitude: 105 },
    accuracyMeters: 5,
    isLowAccuracyOverride: false,
    lowAccuracyReason: null,
    capturedAt: new Date('2026-08-29T00:00:00.000Z')
  };
}

describe('getExecutiveActiveProjectDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findProjectsByIdList.mockResolvedValue([{ projectId: 'project-1', status: 'ACTIVE', organizationId: 'org-1', name: 'Dự án kiểm tra', description: 'Mô tả' }]);
    mocks.findUsersByIds.mockResolvedValue([]);
    mocks.findGeofencesByProjectIds.mockResolvedValue([{ projectId: 'project-1', polygon: [] }]);
    mocks.findDisbursementsByProjectIds.mockResolvedValue([]);
    mocks.countPendingDisbursementsByProjectIds.mockResolvedValue(new Map());
    mocks.countAuditorFieldReportsByProjectIds.mockResolvedValue(new Map());
    mocks.findAuditorFieldReportGeofenceMetadataByProjectIds.mockResolvedValue([]);
    mocks.findDonationSummariesByProjectIds.mockResolvedValue(new Map());
    mocks.findLatestSubmissionsByOrganizationIds.mockResolvedValue([]);
    mocks.findExecutivePendingPublicationProjectsFromRepository.mockResolvedValue([]);
    mocks.findProjectById.mockResolvedValue(null);
    mocks.findPendingProjectArbitrationsByProjectRoundsFromRepository.mockResolvedValue([]);
    mocks.findProjectChallengesByProjectRoundsFromRepository.mockResolvedValue([]);
    mocks.findProjectChallengeReferencesByProjectRoundsFromRepository.mockResolvedValue([]);
    mocks.findListingVerificationsByProjectRounds.mockResolvedValue([]);
    mocks.countListingVerificationsByProjectRounds.mockResolvedValue([]);
    mocks.isPointInsidePolygon.mockReturnValue(false);
    mocks.distanceFromPointToPolygonMeters
      .mockReturnValueOnce(800)
      .mockReturnValueOnce(10);
    mocks.haversineDistance.mockReturnValue(25);
  });

  it('giữ toàn bộ ảnh từ nhiều biên bản và không che mức sai lệch CRITICAL', async () => {
    mocks.findAuditorFieldReportsByProjectIds.mockResolvedValue([
      { projectId: 'project-1', photos: [createFieldPhoto('cid-critical')] },
      { projectId: 'project-1', photos: [createFieldPhoto('cid-inside')] }
    ]);

    const detail = (await getExecutiveActiveProjectDetails(['project-1'])).get('project-1');

    expect(detail?.evidencePhotos.map(photo => photo.cid)).toEqual(['cid-critical', 'cid-inside']);
    expect(detail?.highestDeviationLevel).toBe('CRITICAL');
  });

  it('giữ ảnh xác minh đã chụp ở vòng niêm yết khi dự án chuyển sang ACTIVE', async () => {
    mocks.findAuditorFieldReportsByProjectIds.mockResolvedValue([]);
    mocks.findListingVerificationsByProjectRounds.mockResolvedValue([{
      verificationId: 'verification-1', projectId: 'project-1', round: 1, auditorUserId: 'auditor-1',
      note: 'Đã xác minh thực địa trước khi kích hoạt.', submittedAt: new Date('2026-08-29T00:00:00.000Z'),
      photos: [createFieldPhoto('cid-listing-verification')]
    }]);
    mocks.findUsersByIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'auditor-1', fullName: 'Kiểm toán viên A' }]);

    const detail = (await getExecutiveActiveProjectDetails(['project-1'])).get('project-1');

    expect(detail?.listingVerifications).toEqual([expect.objectContaining({
      verificationId: 'verification-1',
      auditorLabel: 'Kiểm toán viên A',
      note: 'Đã xác minh thực địa trước khi kích hoạt.',
      evidencePhotos: [expect.objectContaining({ cid: 'cid-listing-verification', source: 'AUDITOR_LISTING_VERIFICATION' })]
    })]);
    expect(detail?.evidencePhotos).toEqual([expect.objectContaining({ cid: 'cid-listing-verification', source: 'AUDITOR_LISTING_VERIFICATION' })]);
  });

  it('trả NO_GEOFENCE và không gọi phép tính hình học khi ảnh không có geofence', () => {
    const photo = buildExecutiveEvidencePhoto({
      cid: 'cid-no-geofence', source: 'AUDITOR_FIELD_REPORT', gps: { lat: 21, lng: 105 }, accuracyMeters: 5,
      geofence: null, isLowAccuracyOverride: false, lowAccuracyReason: null, capturedAt: null
    });

    expect(photo).toMatchObject({ isInsideGeofence: null, distanceMeters: null, distanceToProjectCenterMeters: null, deviationLevel: 'NO_GEOFENCE' });
    expect(mocks.isPointInsidePolygon).not.toHaveBeenCalled();
    expect(mocks.distanceFromPointToPolygonMeters).not.toHaveBeenCalled();
    expect(mocks.haversineDistance).not.toHaveBeenCalled();
  });

  it('tách khoảng cách ảnh tới tâm dự án khỏi khoảng cách tới mép geofence dùng để ra verdict', () => {
    mocks.isPointInsidePolygon.mockReturnValue(true);
    mocks.distanceFromPointToPolygonMeters.mockReset().mockReturnValue(0);
    mocks.haversineDistance.mockReturnValue(42.6);
    const gps = { lat: 21.001, lng: 105.001 };
    const centroid = { lat: 21, lng: 105 };
    const photo = buildExecutiveEvidencePhoto({
      cid: 'cid-project-center-distance', source: 'AUDITOR_LISTING_VERIFICATION', gps, accuracyMeters: 5,
      geofence: {
        projectId: 'project-1', polygon: [], centroid, radiusMeters: 100,
        createdAt: new Date('2026-08-29T00:00:00.000Z'), updatedAt: new Date('2026-08-29T00:00:00.000Z')
      }, isLowAccuracyOverride: false, lowAccuracyReason: null, capturedAt: null
    });

    expect(photo).toMatchObject({ distanceMeters: 0, distanceToProjectCenterMeters: 42.6, deviationLevel: 'INSIDE' });
    expect(mocks.haversineDistance).toHaveBeenCalledWith(gps, centroid);
  });

  it('hạ tín nhiệm accuracy client rất lớn khi ảnh dùng low-accuracy override', () => {
    mocks.isPointInsidePolygon.mockReturnValue(false);
    mocks.distanceFromPointToPolygonMeters.mockReset().mockReturnValue(120);
    const photo = buildExecutiveEvidencePhoto({
      cid: 'cid-low-accuracy', source: 'AUDITOR_FIELD_REPORT', gps: { lat: 21, lng: 105 }, accuracyMeters: 2_000,
      geofence: {
        projectId: 'project-1', polygon: [], centroid: { lat: 21, lng: 105 }, radiusMeters: 100,
        createdAt: new Date('2026-08-29T00:00:00.000Z'), updatedAt: new Date('2026-08-29T00:00:00.000Z')
      }, isLowAccuracyOverride: true,
      lowAccuracyReason: 'Tín hiệu GPS thực địa không ổn định.', capturedAt: new Date('2026-08-29T00:00:00.000Z')
    });

    expect(photo).toMatchObject({ deviationLevel: 'DEVIATED', isLowAccuracyOverride: true, lowAccuracyReason: 'Tín hiệu GPS thực địa không ổn định.' });
  });

  it('đếm tất cả field report cùng project và trả cursor theo trang active project', async () => {
    mocks.findProjectsByStatusCursorFromRepository.mockResolvedValue([
      { projectId: 'project-1', organizationId: 'org-1', name: 'Dự án một', milestonePlan: [] },
      { projectId: 'project-2', organizationId: 'org-2', name: 'Dự án hai', milestonePlan: [] }
    ]);
    mocks.findUsersByIds.mockResolvedValue([{ id: 'org-1', organizationName: 'Tổ chức một' }]);
    mocks.countAuditorFieldReportsByProjectIds.mockResolvedValue(new Map([['project-1', 2]]));
    mocks.findAuditorFieldReportGeofenceMetadataByProjectIds.mockResolvedValue([{ projectId: 'project-1', photos: [createFieldPhoto('cid-critical')] }]);
    mocks.countPendingDisbursementsByProjectIds.mockResolvedValue(new Map([['project-1', 3]]));

    const page = await listExecutiveActiveProjects(null, 1);

    expect(mocks.findProjectsByStatusCursorFromRepository).toHaveBeenCalledWith('ACTIVE', null, 2);
    expect(page).toEqual({
      items: [expect.objectContaining({ projectId: 'project-1', organizationName: 'Tổ chức một', fieldReportCount: 2, pendingDisbursementCount: 3 })],
      nextCursor: 'project-1'
    });
  });

  it('ưu tiên challenge đúng listing round hơn verification và gán source evidence chính xác', async () => {
    mocks.findProjectById.mockResolvedValue({
      projectId: 'pending-1', organizationId: 'org-1', name: 'Dự án tranh chấp', description: 'Mô tả', status: 'DISPUTED', listingRound: 2,
      goalAmount: 5000000, deadline: new Date('2026-12-31T00:00:00.000Z'), milestonePlan: [], evidenceFiles: [], listedAt: null, activationEligibleAt: null
    });
    mocks.findUsersByIds.mockResolvedValue([{ id: 'org-1', organizationName: 'Tổ chức A' }, { id: 'auditor-1', fullName: 'Auditor A' }]);
    mocks.findGeofencesByProjectIds.mockResolvedValue([{ projectId: 'pending-1', polygon: [], centroid: { lat: 21, lng: 105 }, radiusMeters: 100 }]);
    mocks.findProjectChallengesByProjectRoundsFromRepository.mockResolvedValue([
      { challengeId: 'challenge-old', projectId: 'pending-1', round: 1, challengerUserId: 'auditor-1', reason: 'Vòng cũ', submittedAt: new Date(), evidencePhotos: [] },
      { challengeId: 'challenge-current', projectId: 'pending-1', round: 2, challengerUserId: 'auditor-1', reason: 'Sai vị trí thực địa', submittedAt: new Date(), evidencePhotos: [createFieldPhoto('cid-challenge')] }
    ]);
    mocks.findListingVerificationsByProjectRounds.mockResolvedValue([
      { verificationId: 'verification-current', projectId: 'pending-1', round: 2, auditorUserId: 'auditor-1', note: 'Đã xác minh', submittedAt: new Date(), photos: [createFieldPhoto('cid-verification')] }
    ]);
    mocks.findPendingProjectArbitrationsByProjectRoundsFromRepository.mockResolvedValue([{
      arbitrationId: 'case-1', openedByChallengeId: 'challenge-current', projectId: 'pending-1', round: 2, deadlineAt: new Date(Date.now() + 60_000), requiredMemberVotes: 2,
      committeeSnapshot: [{ userId: 'member-1', role: 'executive_member' }], votes: []
    }]);

    const detail = await getExecutivePendingPublicationProjectDetail('pending-1', 'member-1');

    expect(detail.evidence.mode).toBe('CHALLENGE');
    expect(detail.evidence.records).toHaveLength(1);
    expect(detail.evidence.records[0]).toMatchObject({ recordId: 'challenge-current', reason: 'Sai vị trí thực địa' });
    expect(detail.evidence.records[0].evidencePhotos[0].source).toBe('PROJECT_CHALLENGE');
    expect(detail.arbitration).toMatchObject({ arbitrationId: 'case-1', canCurrentUserVote: true });
  });

  it('fail-closed khi arbitration không còn trỏ tới challenge của đúng vòng', async () => {
    mocks.findProjectById.mockResolvedValue({
      projectId: 'pending-corrupt', organizationId: 'org-1', name: 'Dự án lỗi liên kết', description: 'Mô tả', status: 'DISPUTED', listingRound: 2,
      goalAmount: 5000000, deadline: new Date('2026-12-31T00:00:00.000Z'), milestonePlan: [], evidenceFiles: [], listedAt: null, activationEligibleAt: null
    });
    mocks.findProjectChallengesByProjectRoundsFromRepository.mockResolvedValue([
      { challengeId: 'challenge-existing', projectId: 'pending-corrupt', round: 2, challengerUserId: 'auditor-1', reason: 'Sai vị trí', submittedAt: new Date(), evidencePhotos: [] }
    ]);
    mocks.findPendingProjectArbitrationsByProjectRoundsFromRepository.mockResolvedValue([{
      arbitrationId: 'case-corrupt', openedByChallengeId: 'challenge-missing', projectId: 'pending-corrupt', round: 2, deadlineAt: new Date(Date.now() + 60_000), requiredMemberVotes: 2,
      committeeSnapshot: [{ userId: 'member-1', role: 'executive_member' }], votes: []
    }]);

    const detail = await getExecutivePendingPublicationProjectDetail('pending-corrupt', 'member-1');

    expect(detail.integrityIssues).toEqual(['MISSING_CHALLENGE']);
    expect(detail.arbitration?.canCurrentUserVote).toBe(false);
  });

  it('chỉ báo MISSING_ARBITRATION khi challenge hiện tại vẫn đầy đủ nhưng case xét xử bị thiếu', async () => {
    mocks.findProjectById.mockResolvedValue({
      projectId: 'pending-no-case', organizationId: 'org-1', name: 'Dự án thiếu case', description: 'Mô tả', status: 'DISPUTED', listingRound: 1,
      goalAmount: 5000000, deadline: new Date('2026-12-31T00:00:00.000Z'), milestonePlan: [], evidenceFiles: [], listedAt: null, activationEligibleAt: null
    });
    mocks.findProjectChallengesByProjectRoundsFromRepository.mockResolvedValue([
      { challengeId: 'challenge-present', projectId: 'pending-no-case', round: 1, challengerUserId: 'auditor-1', reason: 'Sai vị trí', submittedAt: new Date(), evidencePhotos: [] }
    ]);
    mocks.findPendingProjectArbitrationsByProjectRoundsFromRepository.mockResolvedValue([]);

    const detail = await getExecutivePendingPublicationProjectDetail('pending-no-case', 'member-1');

    expect(detail.integrityIssues).toEqual(['MISSING_ARBITRATION']);
    expect(detail.arbitration).toBeNull();
  });

  it('trả UNVERIFIED cho dự án pending không có evidence và không làm lộ record chi tiết ở summary', async () => {
    mocks.findExecutivePendingPublicationProjectsFromRepository.mockResolvedValue([{
      projectId: 'pending-2', organizationId: 'org-2', name: 'Dự án chờ', description: 'Mô tả', status: 'PENDING_ACTIVATION', listingRound: 1,
      goalAmount: 1000000, deadline: new Date('2026-12-31T00:00:00.000Z'), milestonePlan: [], evidenceFiles: [], listedAt: null, activationEligibleAt: null
    }]);
    mocks.findUsersByIds.mockResolvedValue([{ id: 'org-2', organizationName: 'Tổ chức B' }]);
    mocks.findProjectChallengeReferencesByProjectRoundsFromRepository.mockResolvedValue([]);

    const page = await listExecutivePendingPublicationProjects(null, 20, 'member-1');

    expect(page.items).toEqual([expect.objectContaining({ projectId: 'pending-2', status: 'PENDING_ACTIVATION', evidence: { mode: 'UNVERIFIED', records: [] } })]);
    expect(page.nextCursor).toBeNull();
  });
});
