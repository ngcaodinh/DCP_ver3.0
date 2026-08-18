import { EventEmitter } from 'events';

/**
 * EventEmitter cho sự kiện Oracle AI (EXIF GPS verification).
 * Pattern giống webhookEvents: bridge tạm thời giữa oracle service và các listener.
 */
export const oracleEvents = new EventEmitter();
oracleEvents.setMaxListeners(100);

/** Loại sự kiện oracle. */
export type OracleEventType =
  | 'evidence.uploaded'
  | 'oracle.verified'
  | 'override.requested'
  | 'override.executed';

/**
 * Payload cho evidence.uploaded — phát ra khi tổ chức upload ảnh minh chứng.
 * Oracle worker lắng nghe event này để tự động trigger verification.
 * Worker tự fetch buffer ảnh từ IPFS gateway dùng evidenceCid — không truyền buffer qua event.
 */
export type EvidenceUploadedEventPayload = {
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  fileSizeBytes: number;
  /** Link disbursement request để override request có thể auto-approve khi N/N vote APPROVE. null nếu upload độc lập. */
  disbursementRequestId?: string | null;
};

/**
 * Payload cho oracle.verified — kết quả xác minh EXIF GPS của ảnh minh chứng.
 */
export type OracleVerifiedEventPayload = {
  verificationId: string;
};

/**
 * Payload cho override.requested — yêu cầu ghi đè GPS cần N/N commissioner vote.
 */
export type OverrideRequestedEventPayload = {
  overrideRequestId: string;
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  gpsFromImage: { lat: number; lng: number } | null;
  gpsFromProject: { lat: number; lng: number };
  distance: number | null;
  reason: 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE';
  commissionerCount: number;  // Số lượng commissioner trong snapshot — để FE hiển thị "chờ X người vote"
};

/**
 * Payload cho override.executed — phát ra khi override request được resolve (APPROVED hoặc REJECTED).
 * APPROVED: toàn bộ N/N commissioner vote APPROVE.
 * REJECTED: bất kỳ commissioner nào vote REJECT (kết thúc ngay lập tức).
 * Đây là event off-chain dùng cho socket/audit của Lane B. Event on-chain
 * sẽ do oracle smart contract/Lane D5 phát sau khi contract được triển khai.
 */
export type OverrideExecutedEventPayload = {
  overrideRequestId: string;
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  disbursementRequestId: string | null;  // null nếu không link disbursement
  totalVoters: number;
  executedAt: Date;
  status: 'APPROVED' | 'REJECTED';  // kết quả cuối — để FE/socket forward đúng status
};
