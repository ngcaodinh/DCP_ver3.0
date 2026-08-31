import { determineGeofenceDeviationLevel, type GeofenceDeviationLevel } from '../constants/geofenceDeviationPolicy';
import { findUsersByIds } from '../models/authModel';
import {
  countAuditorFieldReportsByProjectIds,
  findAuditorFieldReportGeofenceMetadataByProjectIds,
  findAuditorFieldReportsByProjectIds,
  type AuditorFieldReportRecord
} from '../models/auditorFieldReportModel';
import { countPendingDisbursementsByProjectIds, findDisbursementsByProjectIds, type DisbursementRecord } from '../models/disbursementModel';
import { findGeofencesByProjectIds, type GpsCoordinate, type ProjectGeofenceRecord } from '../models/projectGeofenceModel';
import { findLatestSubmissionsByOrganizationIds, type OrganizationKycSubmission } from '../models/organizationKycModel';
import {
  countListingVerificationsByProjectRounds,
  findListingVerificationsByProjectRounds,
  type AuditorListingVerificationRecord
} from '../models/auditorListingVerificationModel';
import { type ProjectChallengeRecord } from '../models/projectChallengeModel';
import { type ProjectArbitrationVotingSummaryRecord } from '../models/projectArbitrationModel';
import {
  type ExecutivePendingPublicationCursor,
  type ExecutivePendingPublicationListProject,
  type ProjectRecord
} from '../models/projectModel';
import { findDonationSummariesByProjectIds } from '../repositories/donationRepository';
import { findPendingProjectArbitrationsByProjectRoundsFromRepository } from '../repositories/projectArbitrationRepository';
import {
  findProjectChallengeReferencesByProjectRoundsFromRepository,
  findProjectChallengesByProjectRoundsFromRepository
} from '../repositories/projectChallengeRepository';
import {
  findExecutivePendingPublicationProjectsFromRepository,
  findProjectById,
  findProjectsByIdList,
  findProjectsByStatusCursorFromRepository
} from '../repositories/projectRepository';
import { distanceFromPointToPolygonMeters, haversineDistance, isPointInsidePolygon } from '../utils/geoDistance';
import { ApplicationError } from '../utils/applicationError';

export type ExecutiveEvidenceSource =
  | 'PROJECT_CHALLENGE'
  | 'AUDITOR_LISTING_VERIFICATION'
  | 'AUDITOR_FIELD_REPORT'
  | 'DISBURSEMENT_EVIDENCE';

export type ExecutiveEvidencePhoto = {
  cid: string;
  source: ExecutiveEvidenceSource;
  gps: GpsCoordinate | null;
  accuracyMeters: number;
  distanceMeters: number | null;
  distanceToProjectCenterMeters: number | null;
  isInsideGeofence: boolean | null;
  deviationLevel: GeofenceDeviationLevel;
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
  capturedAt: Date | null;
};

export type ExecutiveKycSummary = {
  status: OrganizationKycSubmission['status'] | 'NOT_SUBMITTED';
  reviewedAt: Date | null;
};

const DEVIATION_SEVERITY: Record<GeofenceDeviationLevel, number> = {
  INSIDE: 0,
  WITHIN_ACCURACY: 1,
  NO_GEOFENCE: 2,
  DEVIATED: 3,
  CRITICAL: 4
};

/** Chuẩn hoá một ảnh bằng chứng sang DTO cảnh báo dùng chung để FE không tự suy diễn chính sách GPS. */
export function buildExecutiveEvidencePhoto(input: {
  cid: string;
  source: ExecutiveEvidenceSource;
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
  // Giữ riêng khoảng cách đến tâm dự án để người dùng thấy độ lệch thực, không thay thế khoảng cách tới mép dùng cho policy geofence.
  const distanceToProjectCenterMeters = input.geofence && input.gps
    ? haversineDistance(input.gps, input.geofence.centroid)
    : null;
  return {
    cid: input.cid,
    source: input.source,
    gps: input.gps,
    accuracyMeters: input.accuracyMeters,
    distanceMeters,
    distanceToProjectCenterMeters,
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

/** Gom record theo projectId để toàn bộ mapper dùng dữ liệu batch thay vì phát sinh query theo từng card. */
function groupByProjectId<T extends { projectId: string }>(records: T[]): Map<string, T[]> {
  const recordsByProjectId = new Map<string, T[]>();
  records.forEach(record => {
    const current = recordsByProjectId.get(record.projectId) || [];
    current.push(record);
    recordsByProjectId.set(record.projectId, current);
  });
  return recordsByProjectId;
}

/** Chuẩn hoá vòng niêm yết hiện hành, bảo vệ dữ liệu lịch sử thiếu giá trị mặc định. */
function getCurrentListingRound(project: Pick<ProjectRecord, 'listingRound'>): number {
  return Number.isInteger(project.listingRound) && (project.listingRound || 0) >= 1 ? project.listingRound! : 1;
}

/** Chỉ chọn hai trường KYC được phép hiển thị, tuyệt đối không đưa hồ sơ/tài liệu KYC vào DTO. */
function getKycSummary(
  organizationId: string,
  kycByOrganizationId: Map<string, Pick<OrganizationKycSubmission, 'organizationId' | 'status' | 'reviewedAt'>>
): ExecutiveKycSummary {
  const kyc = kycByOrganizationId.get(organizationId);
  return kyc ? { status: kyc.status, reviewedAt: kyc.reviewedAt || null } : { status: 'NOT_SUBMITTED', reviewedAt: null };
}

/** Tạo nhãn Auditor nội bộ ổn định nếu tài khoản lịch sử không còn tồn tại. */
function getAuditorLabel(auditorUserId: string | null | undefined, userNameById: Map<string, string>): string {
  const normalizedAuditorUserId = String(auditorUserId || '').trim();
  return userNameById.get(normalizedAuditorUserId) || (normalizedAuditorUserId ? `Kiểm toán viên #${normalizedAuditorUserId.slice(-6)}` : 'Kiểm toán viên chưa xác định');
}

/** Chuyển GPS từ record camera sang shape chung để nguồn evidence nào cũng đi qua cùng chính sách geofence. */
function toGpsCoordinate(photo: { gps?: { latitude: number; longitude: number } }): GpsCoordinate | null {
  return photo.gps ? { lat: photo.gps.latitude, lng: photo.gps.longitude } : null;
}

export type ExecutiveFieldReportEvidence = {
  reportId: string;
  auditorLabel: string;
  note: string;
  verifiedMilestoneIndexes: number[];
  submittedAt: Date;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Ảnh xác minh khi niêm yết được giữ lại sau khi dự án ACTIVE để Ủy ban truy vết đầy đủ. */
export type ExecutiveListingVerificationEvidence = {
  verificationId: string;
  auditorLabel: string;
  note: string | null;
  submittedAt: Date;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

export type ExecutiveDisbursementEvidence = {
  requestId: string;
  amount: number;
  usagePurpose: string;
  status: DisbursementRecord['status'];
  createdAt: Date;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Lấy danh sách dự án ACTIVE cho portal Ủy ban, có metric chỉ đọc và không tải ảnh từng card. */
export async function listExecutiveActiveProjects(cursor: string | null, limitCount: number): Promise<{
  items: Array<{
    projectId: string;
    name: string;
    organizationName: string;
    goalAmount: number;
    donationSummary: { totalAmount: number; donationCount: number };
    kyc: ExecutiveKycSummary;
    fieldReportCount: number;
    pendingDisbursementCount: number;
    highestDeviationLevel: GeofenceDeviationLevel;
  }>;
  nextCursor: string | null;
}> {
  const projects = await findProjectsByStatusCursorFromRepository('ACTIVE', cursor, limitCount + 1);
  const pageProjects = projects.slice(0, limitCount);
  const projectIds = pageProjects.map(project => project.projectId);
  const [organizations, reportCounts, reportGeofenceMetadata, geofences, donationSummaries, kycSubmissions, pendingCounts] = await Promise.all([
    findUsersByIds(pageProjects.map(project => project.organizationId)),
    countAuditorFieldReportsByProjectIds(projectIds),
    findAuditorFieldReportGeofenceMetadataByProjectIds(projectIds),
    findGeofencesByProjectIds(projectIds),
    findDonationSummariesByProjectIds(projectIds),
    findLatestSubmissionsByOrganizationIds(pageProjects.map(project => project.organizationId)),
    countPendingDisbursementsByProjectIds(projectIds)
  ]);
  const organizationNameById = new Map(organizations.map(user => [user.id, user.organizationName || user.fullName]));
  const reportGeofenceMetadataByProjectId = groupByProjectId(reportGeofenceMetadata);
  const geofenceByProjectId = new Map(geofences.map(geofence => [geofence.projectId, geofence]));
  const kycByOrganizationId = new Map(kycSubmissions.map(item => [item.organizationId, item]));
  return {
    items: pageProjects.map(project => ({
      projectId: project.projectId,
      name: project.name,
      organizationName: organizationNameById.get(project.organizationId) || 'Tổ chức chưa xác định',
      goalAmount: project.goalAmount || 0,
      donationSummary: donationSummaries.get(project.projectId) || { totalAmount: 0, donationCount: 0 },
      kyc: getKycSummary(project.organizationId, kycByOrganizationId),
      fieldReportCount: reportCounts.get(project.projectId) || 0,
      pendingDisbursementCount: pendingCounts.get(project.projectId) || 0,
      highestDeviationLevel: (reportGeofenceMetadataByProjectId.get(project.projectId) || [])
        .flatMap(report => report.photos)
        .reduce<GeofenceDeviationLevel>((highest, photo) => {
          const geofence = geofenceByProjectId.get(project.projectId) || null;
          const deviationLevel = determineGeofenceDeviationLevel({
            isInsideGeofence: geofence ? isPointInsidePolygon({ lat: photo.gps.latitude, lng: photo.gps.longitude }, geofence.polygon) : null,
            distanceMeters: geofence ? distanceFromPointToPolygonMeters({ lat: photo.gps.latitude, lng: photo.gps.longitude }, geofence.polygon) : null,
            accuracyMeters: photo.accuracyMeters,
            isLowAccuracyOverride: photo.isLowAccuracyOverride
          });
          return DEVIATION_SEVERITY[deviationLevel] > DEVIATION_SEVERITY[highest] ? deviationLevel : highest;
        }, geofenceByProjectId.has(project.projectId) ? 'INSIDE' : 'NO_GEOFENCE')
    })),
    nextCursor: projects.length > limitCount ? pageProjects[pageProjects.length - 1]?.projectId || null : null
  };
}

/** DTO đầy đủ của dự án ACTIVE, giữ ngữ cảnh report/request để Ủy ban không suy diễn từ một CID rời rạc. */
export type ExecutiveActiveProjectDetail = {
  projectId: string;
  name: string;
  description: string;
  organizationName: string;
  profile: { kyc: ExecutiveKycSummary };
  goalAmount: number;
  deadline: Date;
  donationSummary: { totalAmount: number; donationCount: number };
  milestonePlan: unknown[];
  evidenceFiles: Array<{ cid: string; fileName: string; mimeType: string }>;
  geofence: ProjectGeofenceRecord | null;
  fieldReports: ExecutiveFieldReportEvidence[];
  listingVerifications: ExecutiveListingVerificationEvidence[];
  disbursementEvidence: ExecutiveDisbursementEvidence[];
  evidencePhotos: ExecutiveEvidencePhoto[];
  highestDeviationLevel: GeofenceDeviationLevel;
};

/** Xây batch dữ liệu giám sát ACTIVE để một trang chỉ phát sinh số query hằng thay vì N × 4. */
export async function getExecutiveActiveProjectDetails(projectIds: string[]): Promise<Map<string, ExecutiveActiveProjectDetail>> {
  const normalizedProjectIds = [...new Set(projectIds.map(projectId => String(projectId || '').trim()).filter(Boolean))];
  if (!normalizedProjectIds.length) return new Map();
  const activeProjects = (await findProjectsByIdList(normalizedProjectIds)).filter(project => project.status === 'ACTIVE');
  if (!activeProjects.length) return new Map();
  const activeProjectIds = activeProjects.map(project => project.projectId);
  const [organizationUsers, geofences, fieldReports, listingVerifications, disbursements, donationSummaries, kycSubmissions] = await Promise.all([
    findUsersByIds(activeProjects.map(project => project.organizationId)),
    findGeofencesByProjectIds(activeProjectIds),
    findAuditorFieldReportsByProjectIds(activeProjectIds),
    findListingVerificationsByProjectRounds(activeProjects.map(project => ({ projectId: project.projectId, round: getCurrentListingRound(project) }))),
    findDisbursementsByProjectIds(activeProjectIds, 200),
    findDonationSummariesByProjectIds(activeProjectIds),
    findLatestSubmissionsByOrganizationIds(activeProjects.map(project => project.organizationId))
  ]);
  const auditorUsers = await findUsersByIds([
    ...fieldReports.map(report => report.auditorUserId),
    ...listingVerifications.map(verification => verification.auditorUserId)
  ].filter((userId): userId is string => Boolean(userId)));
  const organizationById = new Map(organizationUsers.map(user => [user.id, user]));
  const userNameById = new Map([...organizationUsers, ...auditorUsers].map(user => [user.id, user.organizationName || user.fullName]));
  const geofenceByProjectId = new Map(geofences.map(geofence => [geofence.projectId, geofence]));
  const fieldReportsByProjectId = groupByProjectId(fieldReports);
  const listingVerificationsByProjectId = groupByProjectId(listingVerifications);
  const disbursementsByProjectId = groupByProjectId(disbursements);
  const kycByOrganizationId = new Map(kycSubmissions.map(item => [item.organizationId, item]));
  return new Map(activeProjects.map(project => {
    const geofence = geofenceByProjectId.get(project.projectId) || null;
    const fieldReportEvidence = (fieldReportsByProjectId.get(project.projectId) || []).map(report => ({
      reportId: report.reportId,
      auditorLabel: getAuditorLabel(report.auditorUserId, userNameById),
      note: report.note,
      verifiedMilestoneIndexes: report.verifiedMilestoneIndexes || [],
      submittedAt: report.submittedAt,
      evidencePhotos: (report.photos || []).map(photo => buildExecutiveEvidencePhoto({
        cid: photo.cid,
        source: 'AUDITOR_FIELD_REPORT',
        gps: toGpsCoordinate(photo),
        accuracyMeters: photo.accuracyMeters,
        geofence,
        isLowAccuracyOverride: photo.isLowAccuracyOverride,
        lowAccuracyReason: photo.lowAccuracyReason,
        capturedAt: photo.capturedAt
      }))
      } satisfies ExecutiveFieldReportEvidence));
    const listingVerificationEvidence = (listingVerificationsByProjectId.get(project.projectId) || [])
      .filter(verification => verification.round === getCurrentListingRound(project))
      .map(verification => ({
        verificationId: verification.verificationId,
        auditorLabel: getAuditorLabel(verification.auditorUserId, userNameById),
        note: verification.note,
        submittedAt: verification.submittedAt,
        evidencePhotos: (verification.photos || []).map(photo => buildExecutiveEvidencePhoto({
          cid: photo.cid,
          source: 'AUDITOR_LISTING_VERIFICATION',
          gps: toGpsCoordinate(photo),
          accuracyMeters: photo.accuracyMeters,
          geofence,
          isLowAccuracyOverride: photo.isLowAccuracyOverride,
          lowAccuracyReason: photo.lowAccuracyReason,
          capturedAt: photo.capturedAt
        }))
      } satisfies ExecutiveListingVerificationEvidence));
    const disbursementEvidence = (disbursementsByProjectId.get(project.projectId) || []).map(disbursement => ({
      requestId: disbursement.requestId,
      amount: disbursement.amount,
      usagePurpose: disbursement.usagePurpose,
      status: disbursement.status,
      createdAt: disbursement.createdAt,
      evidencePhotos: (disbursement.evidencePhotos || []).map(photo => buildExecutiveEvidencePhoto({
        cid: photo.cid,
        source: 'DISBURSEMENT_EVIDENCE',
        gps: toGpsCoordinate(photo),
        accuracyMeters: photo.accuracyMeters,
        geofence,
        isLowAccuracyOverride: photo.lowAccuracyOverride,
        lowAccuracyReason: photo.lowAccuracyReason,
        capturedAt: photo.capturedAt
      }))
    } satisfies ExecutiveDisbursementEvidence));
    const evidencePhotos = [
      ...listingVerificationEvidence.flatMap(verification => verification.evidencePhotos),
      ...fieldReportEvidence.flatMap(report => report.evidencePhotos),
      ...disbursementEvidence.flatMap(request => request.evidencePhotos)
    ];
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
      profile: { kyc: getKycSummary(project.organizationId, kycByOrganizationId) },
      goalAmount: project.goalAmount,
      deadline: project.deadline,
      donationSummary: donationSummaries.get(project.projectId) || { totalAmount: 0, donationCount: 0 },
      milestonePlan: project.milestonePlan || [],
      evidenceFiles: (project.evidenceFiles || []).map(file => ({ cid: file.cid, fileName: file.fileName, mimeType: file.mimeType })),
      geofence,
      fieldReports: fieldReportEvidence,
      listingVerifications: listingVerificationEvidence,
      disbursementEvidence,
      evidencePhotos,
      highestDeviationLevel
    } satisfies ExecutiveActiveProjectDetail];
  }));
}

/** Lấy một hồ sơ giám sát ACTIVE, wrapper giữ boundary API cũ nhưng dùng pipeline batch thống nhất. */
export async function getExecutiveActiveProjectDetail(projectId: string): Promise<ExecutiveActiveProjectDetail> {
  const detail = (await getExecutiveActiveProjectDetails([projectId])).get(projectId);
  if (!detail) throw new ApplicationError('Không tìm thấy dự án đang hoạt động.', 404, 'NOT_FOUND');
  return detail;
}

export type ExecutivePendingEvidenceRecord = {
  recordId: string;
  auditorLabel: string;
  note: string | null;
  reason: string | null;
  submittedAt: Date;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

export type ExecutivePendingEvidence = {
  mode: 'CHALLENGE' | 'VERIFICATION' | 'UNVERIFIED';
  records: ExecutivePendingEvidenceRecord[];
};

export type ExecutiveArbitrationSummary = {
  arbitrationId: string;
  openedByChallengeId: string;
  deadlineAt: Date;
  requiredMemberVotes: number;
  totalCommitteeSeats: number;
  voteCount: number;
  upholdVoteCount: number;
  upholdChairVoteCount: number;
  upholdMemberVoteCount: number;
  rejectVoteCount: number;
  hasCurrentUserVoted: boolean;
  canCurrentUserVote: boolean;
};

export type ExecutivePendingIntegrityIssue = 'MISSING_CHALLENGE' | 'MISSING_ARBITRATION';

export type ExecutivePendingPublicationProjectDetail = {
  projectId: string;
  name: string;
  description: string;
  status: 'PENDING_ACTIVATION' | 'DISPUTED';
  listingRound: number;
  organizationName: string;
  kyc: ExecutiveKycSummary;
  goalAmount: number;
  donationSummary: { totalAmount: number; donationCount: number };
  deadline: Date;
  listedAt: Date | null;
  activationEligibleAt: Date | null;
  challengeCount: number;
  verificationCount: number;
  integrityIssues: ExecutivePendingIntegrityIssue[];
  milestonePlan: unknown[];
  evidenceFiles: Array<{ cid: string; fileName: string; mimeType: string }>;
  geofence: ProjectGeofenceRecord | null;
  evidence: ExecutivePendingEvidence;
  arbitration: ExecutiveArbitrationSummary | null;
};

/** Tạo summary phiếu từ snapshot hiện tại để hai portal hiển thị cùng ngưỡng trước khi ký. */
function buildArbitrationSummary(
  arbitration: Pick<ProjectArbitrationVotingSummaryRecord, 'arbitrationId' | 'openedByChallengeId' | 'deadlineAt' | 'requiredMemberVotes' | 'committeeSnapshot' | 'votes'> | undefined,
  viewerUserId: string
): ExecutiveArbitrationSummary | null {
  if (!arbitration) return null;
  const hasCurrentUserVoted = arbitration.votes.some(vote => vote.voterUserId === viewerUserId);
  const upholdVotes = arbitration.votes.filter(vote => vote.decision === 'UPHOLD_PROJECT');
  return {
    arbitrationId: arbitration.arbitrationId,
    openedByChallengeId: arbitration.openedByChallengeId,
    deadlineAt: arbitration.deadlineAt,
    requiredMemberVotes: arbitration.requiredMemberVotes,
    totalCommitteeSeats: arbitration.committeeSnapshot.length,
    voteCount: arbitration.votes.length,
    upholdVoteCount: upholdVotes.length,
    upholdChairVoteCount: upholdVotes.filter(vote => vote.voterRole === 'executive_chair').length,
    upholdMemberVoteCount: upholdVotes.filter(vote => vote.voterRole === 'executive_member').length,
    rejectVoteCount: arbitration.votes.filter(vote => vote.decision === 'REJECT_PROJECT').length,
    hasCurrentUserVoted,
    canCurrentUserVote: arbitration.deadlineAt > new Date()
      && arbitration.committeeSnapshot.some(member => member.userId === viewerUserId)
      && !hasCurrentUserVoted
  };
}

/** Biến count evidence của vòng hiện tại thành mode cố định để frontend không tự suy luận precedence. */
function buildPendingEvidenceMode(challengeCount: number, verificationCount: number): ExecutivePendingEvidence['mode'] {
  if (challengeCount > 0) return 'CHALLENGE';
  return verificationCount > 0 ? 'VERIFICATION' : 'UNVERIFIED';
}

/** Fail-closed dữ liệu DISPUTED bị thiếu liên kết bắt buộc, không tự tạo record trong API đọc. */
function buildPendingIntegrityIssues(
  status: ExecutivePendingPublicationProjectDetail['status'],
  challengeIds: string[],
  arbitration: ExecutiveArbitrationSummary | null
): ExecutivePendingIntegrityIssue[] {
  if (status !== 'DISPUTED') return [];
  const issues: ExecutivePendingIntegrityIssue[] = [];
  if (challengeIds.length === 0 || (arbitration && !challengeIds.includes(arbitration.openedByChallengeId))) {
    issues.push('MISSING_CHALLENGE');
  }
  if (!arbitration) issues.push('MISSING_ARBITRATION');
  return issues;
}

/** Giải mã opaque cursor của queue và từ chối payload sai thay vì âm thầm trả trang đầu tiên. */
function decodePendingPublicationCursor(rawCursor: string | null): ExecutivePendingPublicationCursor | null {
  if (!rawCursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as Partial<{ status: string; activationEligibleAt: string | null; projectId: string }>;
    if (!parsed || (parsed.status !== 'DISPUTED' && parsed.status !== 'PENDING_ACTIVATION') || typeof parsed.projectId !== 'string' || !parsed.projectId.trim()) {
      throw new Error('invalid cursor');
    }
    const activationEligibleAt = parsed.activationEligibleAt === null ? null : new Date(String(parsed.activationEligibleAt));
    if (activationEligibleAt && Number.isNaN(activationEligibleAt.getTime())) throw new Error('invalid date');
    return { status: parsed.status, activationEligibleAt, projectId: parsed.projectId };
  } catch {
    throw new ApplicationError('Cursor dự án chờ công bố không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
}

/** Mã hoá sort key cuối trang để cursor không phụ thuộc vào thứ tự hiển thị ở frontend. */
function encodePendingPublicationCursor(project: Pick<ProjectRecord, 'projectId' | 'status' | 'activationEligibleAt'>): string {
  if (project.status !== 'DISPUTED' && project.status !== 'PENDING_ACTIVATION') {
    throw new ApplicationError('Không thể mã hóa cursor cho trạng thái dự án này.', 500, 'INTERNAL_ERROR');
  }
  return Buffer.from(JSON.stringify({
    status: project.status,
    activationEligibleAt: project.activationEligibleAt?.toISOString() || null,
    projectId: project.projectId
  })).toString('base64url');
}

/** Chuyển challenge của vòng hiện hành sang record evidence có GPS/geofence do backend tính. */
function mapChallengeEvidence(
  challenge: ProjectChallengeRecord,
  geofence: ProjectGeofenceRecord | null,
  userNameById: Map<string, string>
): ExecutivePendingEvidenceRecord {
  return {
    recordId: challenge.challengeId,
    auditorLabel: getAuditorLabel(challenge.challengerUserId, userNameById),
    note: null,
    reason: challenge.reason,
    submittedAt: challenge.submittedAt,
    evidencePhotos: (challenge.evidencePhotos || []).map(photo => buildExecutiveEvidencePhoto({
      cid: photo.cid,
      source: 'PROJECT_CHALLENGE',
      gps: toGpsCoordinate(photo),
      accuracyMeters: photo.accuracyMeters,
      geofence,
      isLowAccuracyOverride: photo.isLowAccuracyOverride,
      lowAccuracyReason: photo.lowAccuracyReason,
      capturedAt: photo.capturedAt
    }))
  };
}

/** Chuyển xác minh tích cực của vòng hiện hành sang record evidence có GPS/geofence do backend tính. */
function mapVerificationEvidence(
  verification: AuditorListingVerificationRecord,
  geofence: ProjectGeofenceRecord | null,
  userNameById: Map<string, string>
): ExecutivePendingEvidenceRecord {
  return {
    recordId: verification.verificationId,
    auditorLabel: getAuditorLabel(verification.auditorUserId, userNameById),
    note: verification.note,
    reason: null,
    submittedAt: verification.submittedAt,
    evidencePhotos: (verification.photos || []).map(photo => buildExecutiveEvidencePhoto({
      cid: photo.cid,
      source: 'AUDITOR_LISTING_VERIFICATION',
      gps: toGpsCoordinate(photo),
      accuracyMeters: photo.accuracyMeters,
      geofence,
      isLowAccuracyOverride: photo.isLowAccuracyOverride,
      lowAccuracyReason: photo.lowAccuracyReason,
      capturedAt: photo.capturedAt
    }))
  };
}

/** Build read model chờ công bố theo batch, ưu tiên khiếu nại của vòng hiện hành hơn xác minh tích cực. */
async function buildExecutivePendingPublicationProjectDetails(
  projects: ProjectRecord[],
  viewerUserId: string
): Promise<Map<string, ExecutivePendingPublicationProjectDetail>> {
  const pendingProjects = projects.filter((project): project is ProjectRecord & { status: 'PENDING_ACTIVATION' | 'DISPUTED' } => (
    project.status === 'PENDING_ACTIVATION' || project.status === 'DISPUTED'
  ));
  if (!pendingProjects.length) return new Map();
  const projectIds = pendingProjects.map(project => project.projectId);
  const projectRounds = pendingProjects.map(project => ({ projectId: project.projectId, round: getCurrentListingRound(project) }));
  const [organizationUsers, geofences, challenges, verifications, arbitrations, donationSummaries, kycSubmissions] = await Promise.all([
    findUsersByIds(pendingProjects.map(project => project.organizationId)),
    findGeofencesByProjectIds(projectIds),
    findProjectChallengesByProjectRoundsFromRepository(projectRounds),
    findListingVerificationsByProjectRounds(projectRounds),
    findPendingProjectArbitrationsByProjectRoundsFromRepository(projectRounds),
    findDonationSummariesByProjectIds(projectIds),
    findLatestSubmissionsByOrganizationIds(pendingProjects.map(project => project.organizationId))
  ]);
  const evidenceUserIds = [...challenges.map(challenge => challenge.challengerUserId), ...verifications.map(verification => verification.auditorUserId)];
  const auditorUsers = await findUsersByIds(evidenceUserIds);
  const organizationById = new Map(organizationUsers.map(user => [user.id, user]));
  const userNameById = new Map([...organizationUsers, ...auditorUsers].map(user => [user.id, user.organizationName || user.fullName]));
  const geofenceByProjectId = new Map(geofences.map(geofence => [geofence.projectId, geofence]));
  const challengesByProjectId = groupByProjectId(challenges);
  const verificationsByProjectId = groupByProjectId(verifications);
  const arbitrationByProjectRound = new Map(arbitrations.map(arbitration => [`${arbitration.projectId}:${arbitration.round}`, arbitration]));
  const kycByOrganizationId = new Map(kycSubmissions.map(item => [item.organizationId, item]));
  return new Map(pendingProjects.map(project => {
    const listingRound = getCurrentListingRound(project);
    const geofence = geofenceByProjectId.get(project.projectId) || null;
    const currentChallenges = (challengesByProjectId.get(project.projectId) || []).filter(challenge => challenge.round === listingRound);
    const currentVerifications = (verificationsByProjectId.get(project.projectId) || []).filter(verification => verification.round === listingRound);
    const challengeCount = currentChallenges.length;
    const verificationCount = currentVerifications.length;
    const evidenceMode = buildPendingEvidenceMode(challengeCount, verificationCount);
    const evidence: ExecutivePendingEvidence = evidenceMode === 'CHALLENGE'
      ? { mode: evidenceMode, records: currentChallenges.map(challenge => mapChallengeEvidence(challenge, geofence, userNameById)) }
      : evidenceMode === 'VERIFICATION'
        ? { mode: evidenceMode, records: currentVerifications.map(verification => mapVerificationEvidence(verification, geofence, userNameById)) }
        : { mode: evidenceMode, records: [] };
    const arbitration = arbitrationByProjectRound.get(`${project.projectId}:${listingRound}`);
    const initialArbitrationSummary = project.status === 'DISPUTED' ? buildArbitrationSummary(arbitration, viewerUserId) : null;
    const integrityIssues = buildPendingIntegrityIssues(project.status, currentChallenges.map(challenge => challenge.challengeId), initialArbitrationSummary);
    const arbitrationSummary = initialArbitrationSummary && integrityIssues.length
      ? { ...initialArbitrationSummary, canCurrentUserVote: false }
      : initialArbitrationSummary;
    const organization = organizationById.get(project.organizationId);
    return [project.projectId, {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      status: project.status,
      listingRound,
      organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định',
      kyc: getKycSummary(project.organizationId, kycByOrganizationId),
      goalAmount: project.goalAmount,
      donationSummary: donationSummaries.get(project.projectId) || { totalAmount: 0, donationCount: 0 },
      deadline: project.deadline,
      listedAt: project.listedAt || null,
      activationEligibleAt: project.activationEligibleAt || null,
      challengeCount,
      verificationCount,
      integrityIssues,
      milestonePlan: project.milestonePlan || [],
      evidenceFiles: (project.evidenceFiles || []).map(file => ({ cid: file.cid, fileName: file.fileName, mimeType: file.mimeType })),
      geofence,
      evidence,
      arbitration: arbitrationSummary
    } satisfies ExecutivePendingPublicationProjectDetail];
  }));
}

/** Dựng summary queue theo batch, chỉ lấy count/mode thay vì hydrate ảnh evidence của từng card. */
async function buildExecutivePendingPublicationProjectSummaries(
  projects: ExecutivePendingPublicationListProject[],
  viewerUserId: string
): Promise<Array<Pick<ExecutivePendingPublicationProjectDetail, 'projectId' | 'name' | 'status' | 'listingRound' | 'organizationName' | 'kyc' | 'goalAmount' | 'donationSummary' | 'listedAt' | 'activationEligibleAt' | 'challengeCount' | 'verificationCount' | 'integrityIssues' | 'evidence' | 'arbitration'>>> {
  const pendingProjects = projects.filter((project): project is ExecutivePendingPublicationListProject & { status: 'PENDING_ACTIVATION' | 'DISPUTED' } => (
    project.status === 'PENDING_ACTIVATION' || project.status === 'DISPUTED'
  ));
  if (!pendingProjects.length) return [];
  const projectIds = pendingProjects.map(project => project.projectId);
  const projectRounds = pendingProjects.map(project => ({ projectId: project.projectId, round: getCurrentListingRound(project) }));
  const [organizationUsers, challengeReferences, verificationCounts, arbitrations, donationSummaries, kycSubmissions] = await Promise.all([
    findUsersByIds(pendingProjects.map(project => project.organizationId)),
    findProjectChallengeReferencesByProjectRoundsFromRepository(projectRounds),
    countListingVerificationsByProjectRounds(projectRounds),
    findPendingProjectArbitrationsByProjectRoundsFromRepository(projectRounds),
    findDonationSummariesByProjectIds(projectIds),
    findLatestSubmissionsByOrganizationIds(pendingProjects.map(project => project.organizationId))
  ]);
  const organizationById = new Map(organizationUsers.map(user => [user.id, user]));
  const challengeIdsByProjectRound = new Map<string, string[]>();
  challengeReferences.forEach(challenge => {
    const key = `${challenge.projectId}:${challenge.round}`;
    challengeIdsByProjectRound.set(key, [...(challengeIdsByProjectRound.get(key) || []), challenge.challengeId]);
  });
  const verificationCountByProjectRound = new Map(verificationCounts.map(item => [`${item.projectId}:${item.round}`, item.count]));
  const arbitrationByProjectRound = new Map(arbitrations.map(arbitration => [`${arbitration.projectId}:${arbitration.round}`, arbitration]));
  const kycByOrganizationId = new Map(kycSubmissions.map(item => [item.organizationId, item]));
  return pendingProjects.map(project => {
    const listingRound = getCurrentListingRound(project);
    const projectRoundKey = `${project.projectId}:${listingRound}`;
    const challengeIds = challengeIdsByProjectRound.get(projectRoundKey) || [];
    const challengeCount = challengeIds.length;
    const verificationCount = verificationCountByProjectRound.get(projectRoundKey) || 0;
    const initialArbitration = project.status === 'DISPUTED'
      ? buildArbitrationSummary(arbitrationByProjectRound.get(projectRoundKey), viewerUserId)
      : null;
    const integrityIssues = buildPendingIntegrityIssues(project.status, challengeIds, initialArbitration);
    const arbitration = initialArbitration && integrityIssues.length
      ? { ...initialArbitration, canCurrentUserVote: false }
      : initialArbitration;
    const organization = organizationById.get(project.organizationId);
    return {
      projectId: project.projectId,
      name: project.name,
      status: project.status,
      listingRound,
      organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định',
      kyc: getKycSummary(project.organizationId, kycByOrganizationId),
      goalAmount: project.goalAmount,
      donationSummary: donationSummaries.get(project.projectId) || { totalAmount: 0, donationCount: 0 },
      listedAt: project.listedAt || null,
      activationEligibleAt: project.activationEligibleAt || null,
      challengeCount,
      verificationCount,
      integrityIssues,
      evidence: { mode: buildPendingEvidenceMode(challengeCount, verificationCount), records: [] },
      arbitration
    };
  });
}

/** Lấy danh sách chờ công bố với summary redacted, DISPUTED đứng đầu và evidence mode do backend quyết định. */
export async function listExecutivePendingPublicationProjects(
  rawCursor: string | null,
  limitCount: number,
  viewerUserId: string
): Promise<{
  items: Array<Pick<ExecutivePendingPublicationProjectDetail, 'projectId' | 'name' | 'status' | 'listingRound' | 'organizationName' | 'kyc' | 'goalAmount' | 'donationSummary' | 'listedAt' | 'activationEligibleAt' | 'challengeCount' | 'verificationCount' | 'integrityIssues' | 'evidence' | 'arbitration'>>;
  nextCursor: string | null;
}> {
  const cursor = decodePendingPublicationCursor(rawCursor);
  const projects = await findExecutivePendingPublicationProjectsFromRepository(cursor, limitCount + 1);
  const pageProjects = projects.slice(0, limitCount);
  const items = await buildExecutivePendingPublicationProjectSummaries(pageProjects, viewerUserId);
  return {
    items,
    nextCursor: projects.length > limitCount && pageProjects.length
      ? encodePendingPublicationCursor(pageProjects[pageProjects.length - 1])
      : null
  };
}

/** Lấy chi tiết một dự án chờ công bố, từ chối IDOR và mọi status nằm ngoài hai trạng thái được phép. */
export async function getExecutivePendingPublicationProjectDetail(
  projectId: string,
  viewerUserId: string
): Promise<ExecutivePendingPublicationProjectDetail> {
  const project = await findProjectById(projectId);
  const detail = project ? (await buildExecutivePendingPublicationProjectDetails([project], viewerUserId)).get(projectId) : null;
  if (!detail) throw new ApplicationError('Không tìm thấy dự án chờ công bố.', 404, 'NOT_FOUND');
  return detail;
}
