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
  | 'override.requested';

/**
 * Payload cho evidence.uploaded — phát ra khi tổ chức upload ảnh minh chứng.
 * Oracle worker lắng nghe event này để tự động trigger verification.
 * imageBufferBase64 chứa buffer ảnh encode base64 (max 10MB).
 * TODO: Khi có IPFS fetch support, thay imageBufferBase64 bằng evidenceCid và worker tự fetch.
 */
export type EvidenceUploadedEventPayload = {
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  imageBufferBase64: string;
  fileSizeBytes: number;
};

/**
 * Payload cho oracle.verified — kết quả xác minh EXIF GPS của ảnh minh chứng.
 */
export type OracleVerifiedEventPayload = {
  verificationId: string;
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  isValid: boolean | null;
  distance: number | null;    // mét, null nếu GPS_EXIF_MISSING
  reason: string | null;
};

/**
 * Payload cho override.requested — yêu cầu ghi đè GPS cần 3/3 commissioner vote.
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
};
