/**
 * Shared domain types cho Override Voting (B4).
 * Gom các type trùng lặp giữa OverrideVoteDrawer.tsx và useOverrideRequests.ts
 * vào một module chung để đảm bảo đồng bộ.
 */

// =============================================================================
// COORDINATE & STATUS
// =============================================================================

/** Tọa độ GPS theo chuẩn WGS84. */
export type GpsCoordinate = { lat: number; lng: number };

/** Lý do tạo override request. */
export type OverrideReason = 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE';

/** Trạng thái vòng đời của override request. */
export type OverrideStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** Hướng biểu quyết của một commissioner. */
export type VoteDirection = 'APPROVE' | 'REJECT';

// =============================================================================
// COMMISSIONER & VOTE
// =============================================================================

/** Một phiếu biểu quyết của commissioner. */
export type CommissionerVote = {
  commissionerId: string;
  commissionerRole: string;
  vote: VoteDirection;
  reason: string;
  votedAt: string;
};

/**
 * Snapshot commissioners tại thời điểm tạo request.
 * BE redact userId khi trả về → mỗi entry chỉ giữ role và cờ isCurrentUser.
 * BE nội bộ vẫn lưu đầy đủ userId (xem OracleOverrideRequestRecord ở BE).
 */
export type CommissionerSnapshotEntry = {
  role: string;
  isCurrentUser: boolean;
};

/** Domain đầy đủ của một override request (sau khi ánh xạ response từ BE). */
export type OverrideRequestItem = {
  overrideRequestId: string;
  projectId: string;
  /**
   * Tên dự án do BE enrich từ projectModel. Có thể null khi project bị xóa.
   * FE drawer nên hiển thị projectName nếu có, fallback về projectId (xem projectDisplayName).
   */
  projectName?: string | null;
  /** Tên dự án fallback thân thiện (BE đảm bảo luôn không null — fallback về projectId). */
  projectDisplayName?: string;
  organizationId: string;
  evidenceCid: string;
  disbursementRequestId: string | null;
  reason: OverrideReason;
  gpsFromImage: GpsCoordinate | null;
  gpsFromProject: GpsCoordinate;
  distanceMeters: number | null;
  /** Snapshot đã được BE redact — không chứa userId (xem CommissionerSnapshotEntry). */
  commissionerSnapshot: CommissionerSnapshotEntry[];
  /** Phiếu của người khác bị ẩn khi PENDING — chỉ chứa vote của currentUser (nếu có). */
  votes: CommissionerVote[];
  status: OverrideStatus;
  createdAt: string;
};

// =============================================================================
// API RESPONSE
// =============================================================================

/** Payload trả về từ POST /api/oracle/override-requests/:id/vote. */
export type VoteApiResponseData = {
  outcome: 'VOTE_RECORDED' | 'RESOLVED_APPROVED' | 'RESOLVED_REJECTED';
  pendingVoters?: number;
  totalVoters?: number;
  disbursementAutoApproved?: boolean;
};

/** Payload cho mutation vote. */
export type SubmitOverrideVotePayload = {
  overrideRequestId: string;
  vote: VoteDirection;
  reason: string;
};

// =============================================================================
// CONSTANTS
// =============================================================================

/** Ngưỡng tối thiểu ký tự lý do vote (đồng bộ với Zod schema ở BE). */
export const MIN_VOTE_REASON_LENGTH = 10;

/** Ngưỡng tối đa ký tự lý do vote (đồng bộ với Zod schema ở BE). */
export const MAX_VOTE_REASON_LENGTH = 1000;

/** Khoảng cách Haversine (m) vượt ngưỡng → cảnh báo. */
export const GEOFENCE_DISTANCE_WARNING_METERS = 500;

/** Magic id dùng cho polling signal (không phải real override request). */
export const OVERRIDE_POLLING_SIGNAL_ID = '__poll__';