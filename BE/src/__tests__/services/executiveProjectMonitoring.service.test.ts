import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countPendingDisbursementsByProjectIds: vi.fn(),
  findUsersByIds: vi.fn(),
  findDisbursementsByProjectIds: vi.fn(),
  findAuditorFieldReportsByProjectIds: vi.fn(),
  findGeofencesByProjectIds: vi.fn(),
  findProjectsByIdList: vi.fn(),
  findProjectsByStatusCursorFromRepository: vi.fn(),
  isPointInsidePolygon: vi.fn(),
  distanceFromPointToPolygonMeters: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findUsersByIds: mocks.findUsersByIds }));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementsByProjectIds: mocks.findDisbursementsByProjectIds,
  countPendingDisbursementsByProjectIds: mocks.countPendingDisbursementsByProjectIds
}));
vi.mock('../../models/auditorFieldReportModel', () => ({ findAuditorFieldReportsByProjectIds: mocks.findAuditorFieldReportsByProjectIds }));
vi.mock('../../models/projectGeofenceModel', () => ({ findGeofencesByProjectIds: mocks.findGeofencesByProjectIds }));
vi.mock('../../repositories/projectRepository', () => ({
  findProjectsByIdList: mocks.findProjectsByIdList,
  findProjectsByStatusCursorFromRepository: mocks.findProjectsByStatusCursorFromRepository
}));
vi.mock('../../utils/geoDistance', () => ({ isPointInsidePolygon: mocks.isPointInsidePolygon, distanceFromPointToPolygonMeters: mocks.distanceFromPointToPolygonMeters }));

import {
  buildExecutiveEvidencePhoto,
  getExecutiveActiveProjectDetails,
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
    mocks.isPointInsidePolygon.mockReturnValue(false);
    mocks.distanceFromPointToPolygonMeters
      .mockReturnValueOnce(800)
      .mockReturnValueOnce(10);
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

  it('trả NO_GEOFENCE và không gọi phép tính hình học khi ảnh không có geofence', () => {
    const photo = buildExecutiveEvidencePhoto({
      cid: 'cid-no-geofence', source: 'AUDITOR_FIELD_REPORT', gps: { lat: 21, lng: 105 }, accuracyMeters: 5,
      geofence: null, isLowAccuracyOverride: false, lowAccuracyReason: null, capturedAt: null
    });

    expect(photo).toMatchObject({ isInsideGeofence: null, distanceMeters: null, deviationLevel: 'NO_GEOFENCE' });
    expect(mocks.isPointInsidePolygon).not.toHaveBeenCalled();
    expect(mocks.distanceFromPointToPolygonMeters).not.toHaveBeenCalled();
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
    mocks.findAuditorFieldReportsByProjectIds.mockResolvedValue([
      { projectId: 'project-1' }, { projectId: 'project-1' }
    ]);
    mocks.countPendingDisbursementsByProjectIds.mockResolvedValue(new Map([['project-1', 3]]));

    const page = await listExecutiveActiveProjects(null, 1);

    expect(mocks.findProjectsByStatusCursorFromRepository).toHaveBeenCalledWith('ACTIVE', null, 2);
    expect(page).toEqual({
      items: [expect.objectContaining({ projectId: 'project-1', organizationName: 'Tổ chức một', fieldReportCount: 2, pendingDisbursementCount: 3 })],
      nextCursor: 'project-1'
    });
  });
});
