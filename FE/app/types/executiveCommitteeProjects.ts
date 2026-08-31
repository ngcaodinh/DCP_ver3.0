/** Kiểu mức lệch geofence do backend tính; UI chỉ render, không tự tính lại policy GPS. */
export type ExecutiveDeviationLevel = 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';

/** Nguồn ảnh evidence đã được backend gán chính xác để tránh nhầm khiếu nại với biên bản tích cực. */
export type ExecutiveEvidenceSource = 'PROJECT_CHALLENGE' | 'AUDITOR_LISTING_VERIFICATION' | 'AUDITOR_FIELD_REPORT' | 'DISBURSEMENT_EVIDENCE';

/** Ảnh evidence an toàn để hiển thị cho Ủy ban, không chứa hash nội bộ hay metadata thiết bị nhạy cảm. */
export type ExecutiveEvidencePhoto = {
  cid: string;
  source: ExecutiveEvidenceSource;
  gps: { lat: number; lng: number } | null;
  accuracyMeters: number;
  distanceMeters: number | null;
  distanceToProjectCenterMeters: number | null;
  isInsideGeofence: boolean | null;
  deviationLevel: ExecutiveDeviationLevel;
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
  capturedAt: string | null;
};

/** Trạng thái KYC đã redacted cho portal Ủy ban. */
export type ExecutiveKycSummary = {
  status: 'DRAFT' | 'SUBMITTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'NOT_SUBMITTED';
  reviewedAt: string | null;
};

/** Polygon và metadata geofence được read model trả cho bản đồ chỉ đọc. */
export type ExecutiveGeofence = {
  polygon: Array<{ lat: number; lng: number }>;
  centroid: { lat: number; lng: number };
  radiusMeters: number;
} | null;

/** Summary card cho danh sách dự án ACTIVE. */
export type ExecutiveActiveProjectSummary = {
  projectId: string;
  name: string;
  organizationName: string;
  goalAmount: number;
  donationSummary: { totalAmount: number; donationCount: number };
  kyc: ExecutiveKycSummary;
  fieldReportCount: number;
  pendingDisbursementCount: number;
  highestDeviationLevel: ExecutiveDeviationLevel;
};

/** Biên bản hiện trường có ngữ cảnh đầy đủ để không chỉ hiện CID rời rạc. */
export type ExecutiveFieldReportEvidence = {
  reportId: string;
  auditorLabel: string;
  note: string;
  verifiedMilestoneIndexes: number[];
  submittedAt: string;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Ảnh xác minh khi niêm yết được giữ lại để truy vết sau khi dự án hoạt động. */
export type ExecutiveListingVerificationEvidence = {
  verificationId: string;
  auditorLabel: string;
  note: string | null;
  submittedAt: string;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Evidence của yêu cầu giải ngân kèm lý do và trạng thái request. */
export type ExecutiveDisbursementEvidence = {
  requestId: string;
  amount: number;
  usagePurpose: string;
  status: string;
  createdAt: string;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Chi tiết dự án ACTIVE của portal Chair/Member. */
export type ExecutiveActiveProjectDetail = {
  projectId: string;
  name: string;
  description: string;
  organizationName: string;
  profile: { kyc: ExecutiveKycSummary };
  goalAmount: number;
  deadline: string;
  donationSummary: { totalAmount: number; donationCount: number };
  milestonePlan: unknown[];
  evidenceFiles: Array<{ cid: string; fileName: string; mimeType: string }>;
  geofence: ExecutiveGeofence;
  fieldReports: ExecutiveFieldReportEvidence[];
  listingVerifications: ExecutiveListingVerificationEvidence[];
  disbursementEvidence: ExecutiveDisbursementEvidence[];
  evidencePhotos: ExecutiveEvidencePhoto[];
  highestDeviationLevel: ExecutiveDeviationLevel;
};

/** Record khiếu nại hoặc xác minh tích cực của đúng vòng niêm yết hiện hành. */
export type ExecutivePendingEvidenceRecord = {
  recordId: string;
  auditorLabel: string;
  note: string | null;
  reason: string | null;
  submittedAt: string;
  evidencePhotos: ExecutiveEvidencePhoto[];
};

/** Union do backend quyết định thứ tự ưu tiên evidence. */
export type ExecutivePendingEvidence =
  | { mode: 'CHALLENGE'; records: ExecutivePendingEvidenceRecord[] }
  | { mode: 'VERIFICATION'; records: ExecutivePendingEvidenceRecord[] }
  | { mode: 'UNVERIFIED'; records: ExecutivePendingEvidenceRecord[] };

/** Trạng thái biểu quyết của case gắn với dự án DISPUTED. */
export type ExecutiveArbitrationSummary = {
  arbitrationId: string;
  openedByChallengeId: string;
  deadlineAt: string;
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

/** Liên kết bắt buộc bị thiếu ở dự án DISPUTED; UI chỉ cảnh báo và khóa vote, không tự tạo dữ liệu. */
export type ExecutivePendingIntegrityIssue = 'MISSING_CHALLENGE' | 'MISSING_ARBITRATION';

/** Summary cho list dự án chờ công bố. */
export type ExecutivePendingPublicationProjectSummary = {
  projectId: string;
  name: string;
  status: 'PENDING_ACTIVATION' | 'DISPUTED';
  listingRound: number;
  organizationName: string;
  kyc: ExecutiveKycSummary;
  goalAmount: number;
  donationSummary: { totalAmount: number; donationCount: number };
  listedAt: string | null;
  activationEligibleAt: string | null;
  challengeCount: number;
  verificationCount: number;
  integrityIssues: ExecutivePendingIntegrityIssue[];
  evidence: Pick<ExecutivePendingEvidence, 'mode'> & { records: [] };
  arbitration: ExecutiveArbitrationSummary | null;
};

/** Detail dự án chờ công bố, chỉ có dữ liệu nghiệp vụ cần thiết và KYC đã redacted. */
export type ExecutivePendingPublicationProjectDetail = Omit<ExecutivePendingPublicationProjectSummary, 'evidence'> & {
  description: string;
  deadline: string;
  milestonePlan: unknown[];
  evidenceFiles: Array<{ cid: string; fileName: string; mimeType: string }>;
  geofence: ExecutiveGeofence;
  evidence: ExecutivePendingEvidence;
};

/** Trang cursor dùng chung cho hai queue của portal. */
export type ExecutiveCursorPage<T> = { items: T[]; nextCursor: string | null };
