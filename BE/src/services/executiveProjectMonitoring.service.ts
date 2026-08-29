import { determineGeofenceDeviationLevel, type GeofenceDeviationLevel } from '../constants/geofenceDeviationPolicy';
import { findUsersByIds } from '../models/authModel';
import { countPendingDisbursementsByProjectIds, findDisbursementsByProjectIds } from '../models/disbursementModel';
import { findAuditorFieldReportsByProjectIds } from '../models/auditorFieldReportModel';
import { findGeofencesByProjectIds, type GpsCoordinate, type ProjectGeofenceRecord } from '../models/projectGeofenceModel';
import { findProjectsByIdList, findProjectsByStatusCursorFromRepository } from '../repositories/projectRepository';
import { distanceFromPointToPolygonMeters, isPointInsidePolygon } from '../utils/geoDistance';
import { ApplicationError } from '../utils/applicationError';

export type ExecutiveEvidencePhoto = {
  cid: string;
  source: 'AUDITOR_FIELD_REPORT' | 'DISBURSEMENT_EVIDENCE';
  gps: GpsCoordinate | null;
  accuracyMeters: number;
  distanceMeters: number | null;
  isInsideGeofence: boolean | null;
  deviationLevel: GeofenceDeviationLevel;
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
  capturedAt: Date | null;
};

const DEVIATION_SEVERITY: Record<GeofenceDeviationLevel, number> = {
  INSIDE: 0,
  WITHIN_ACCURACY: 1,
  NO_GEOFENCE: 2,
  DEVIATED: 3,
  CRITICAL: 4
};

/** Tính DTO cảnh báo cho một ảnh tại backend để FE không thể tự lệch chính sách. */
/** Chuẩn hoá một ảnh bằng chứng sang DTO cảnh báo dùng chung cho mọi màn Ủy ban. */
export function buildExecutiveEvidencePhoto(input: {
  cid: string;
  source: ExecutiveEvidencePhoto['source'];
  gps: GpsCoordinate | null;
  accuracyMeters: number;
  geofence: ProjectGeofenceRecord | null;
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
  capturedAt: Date | null;
}): ExecutiveEvidencePhoto {
  const isInsideGeofence = input.geofence && input.gps
    ? isPointInsidePolygon(input.gps, input.geofence.polygon)
    : null;
  const distanceMeters = input.geofence && input.gps
    ? distanceFromPointToPolygonMeters(input.gps, input.geofence.polygon)
    : null;
  return {
    cid: input.cid,
    source: input.source,
    gps: input.gps,
    accuracyMeters: input.accuracyMeters,
    distanceMeters,
    isInsideGeofence,
    deviationLevel: determineGeofenceDeviationLevel({
      isInsideGeofence,
      distanceMeters,
      accuracyMeters: input.accuracyMeters,
      isLowAccuracyOverride: input.isLowAccuracyOverride
    }),
    isLowAccuracyOverride: input.isLowAccuracyOverride,
    lowAccuracyReason: input.lowAccuracyReason,
    capturedAt: input.capturedAt
  };
}

/** Gom toàn bộ biên bản theo dự án để evidence và số lượng đều không phụ thuộc thứ tự Mongo trả về. */
function groupFieldReportsByProjectId<T extends { projectId: string }>(fieldReports: T[]): Map<string, T[]> {
  const fieldReportsByProjectId = new Map<string, T[]>();
  fieldReports.forEach(report => {
    const current = fieldReportsByProjectId.get(report.projectId) || [];
    current.push(report);
    fieldReportsByProjectId.set(report.projectId, current);
  });
  return fieldReportsByProjectId;
}

/** Lấy danh sách dự án ACTIVE cho portal Ủy ban, có đủ count để ưu tiên hồ sơ cần theo dõi. */
export async function listExecutiveActiveProjects(cursor: string | null, limitCount: number): Promise<{
  items: Array<{
  projectId: string;
  name: string;
  organizationName: string;
  milestonePlan: unknown[];
  fieldReportCount: number;
  pendingDisbursementCount: number;
  }>;
  nextCursor: string | null;
}> {
  const projects = await findProjectsByStatusCursorFromRepository('ACTIVE', cursor, limitCount + 1);
  const pageProjects = projects.slice(0, limitCount);
  const projectIds = pageProjects.map(project => project.projectId);
  const [organizations, fieldReports, pendingCounts] = await Promise.all([
    findUsersByIds(pageProjects.map(project => project.organizationId)),
    findAuditorFieldReportsByProjectIds(projectIds),
    countPendingDisbursementsByProjectIds(projectIds)
  ]);
  const organizationById = new Map(organizations.map(user => [user.id, user.organizationName || user.fullName]));
  const fieldReportsByProjectId = groupFieldReportsByProjectId(fieldReports);
  return {
    items: pageProjects.map(project => ({
    projectId: project.projectId,
    name: project.name,
    organizationName: organizationById.get(project.organizationId) || 'Tổ chức chưa xác định',
    milestonePlan: project.milestonePlan || [],
    fieldReportCount: fieldReportsByProjectId.get(project.projectId)?.length || 0,
      pendingDisbursementCount: pendingCounts.get(project.projectId) || 0
    })),
    nextCursor: projects.length > limitCount ? pageProjects[pageProjects.length - 1]?.projectId || null : null
  };
}

/** Lấy hồ sơ giám sát của một dự án ACTIVE, gồm geofence và ảnh kiểm toán/tổ chức đã được đối chiếu. */
export type ExecutiveActiveProjectDetail = {
  projectId: string;
  name: string;
  description: string;
  organizationName: string;
  milestonePlan: unknown[];
  geofence: ProjectGeofenceRecord | null;
  evidencePhotos: ExecutiveEvidencePhoto[];
  highestDeviationLevel: GeofenceDeviationLevel;
};

/** Xây batch dữ liệu giám sát để một trang case chỉ phát sinh số query hằng, không phải N × 4. */
export async function getExecutiveActiveProjectDetails(projectIds: string[]): Promise<Map<string, ExecutiveActiveProjectDetail>> {
  const normalizedProjectIds = [...new Set(projectIds.map(projectId => String(projectId || '').trim()).filter(Boolean))];
  if (!normalizedProjectIds.length) return new Map();
  const activeProjects = (await findProjectsByIdList(normalizedProjectIds)).filter(project => project.status === 'ACTIVE');
  if (!activeProjects.length) return new Map();
  const activeProjectIds = activeProjects.map(project => project.projectId);
  const [organizationUsers, geofences, fieldReports, disbursements] = await Promise.all([
    findUsersByIds(activeProjects.map(project => project.organizationId)),
    findGeofencesByProjectIds(activeProjectIds),
    findAuditorFieldReportsByProjectIds(activeProjectIds),
    findDisbursementsByProjectIds(activeProjectIds, 200)
  ]);
  const organizationById = new Map(organizationUsers.map(user => [user.id, user]));
  const geofenceByProjectId = new Map(geofences.map(geofence => [geofence.projectId, geofence]));
  const fieldReportsByProjectId = groupFieldReportsByProjectId(fieldReports);
  const disbursementsByProjectId = new Map<string, typeof disbursements>();
  disbursements.forEach(disbursement => {
    const current = disbursementsByProjectId.get(disbursement.projectId) || [];
    current.push(disbursement);
    disbursementsByProjectId.set(disbursement.projectId, current);
  });
  return new Map(activeProjects.map(project => {
    const geofence = geofenceByProjectId.get(project.projectId) || null;
    const fieldPhotos: ExecutiveEvidencePhoto[] = (fieldReportsByProjectId.get(project.projectId) || []).flatMap(report => report.photos.map(photo => buildExecutiveEvidencePhoto({
      cid: photo.cid,
      source: 'AUDITOR_FIELD_REPORT',
      gps: { lat: photo.gps.latitude, lng: photo.gps.longitude },
      accuracyMeters: photo.accuracyMeters,
      geofence,
      isLowAccuracyOverride: photo.isLowAccuracyOverride,
      lowAccuracyReason: photo.lowAccuracyReason,
      capturedAt: photo.capturedAt
    })));
    const disbursementPhotos: ExecutiveEvidencePhoto[] = (disbursementsByProjectId.get(project.projectId) || []).flatMap(disbursement =>
      (disbursement.evidencePhotos || []).map(photo => buildExecutiveEvidencePhoto({
        cid: photo.cid,
        source: 'DISBURSEMENT_EVIDENCE',
        gps: { lat: photo.gps.latitude, lng: photo.gps.longitude },
        accuracyMeters: photo.accuracyMeters,
        geofence,
        isLowAccuracyOverride: photo.lowAccuracyOverride,
        lowAccuracyReason: photo.lowAccuracyReason,
        capturedAt: photo.capturedAt
      }))
    );
    const evidencePhotos = [...fieldPhotos, ...disbursementPhotos];
    const highestDeviationLevel = evidencePhotos.reduce<GeofenceDeviationLevel>(
      (highest, photo) => DEVIATION_SEVERITY[photo.deviationLevel] > DEVIATION_SEVERITY[highest] ? photo.deviationLevel : highest,
      geofence ? 'INSIDE' : 'NO_GEOFENCE'
    );
    const organization = organizationById.get(project.organizationId);
    return [project.projectId, {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định',
      milestonePlan: project.milestonePlan || [],
      geofence,
      evidencePhotos,
      highestDeviationLevel
    } satisfies ExecutiveActiveProjectDetail];
  }));
}

/** Lấy một hồ sơ giám sát ACTIVE; wrapper giữ boundary API cũ nhưng vẫn dùng pipeline chung. */
export async function getExecutiveActiveProjectDetail(projectId: string): Promise<ExecutiveActiveProjectDetail> {
  const detail = (await getExecutiveActiveProjectDetails([projectId])).get(projectId);
  if (!detail) throw new ApplicationError('Không tìm thấy dự án đang hoạt động.', 404, 'NOT_FOUND');
  return detail;
}
