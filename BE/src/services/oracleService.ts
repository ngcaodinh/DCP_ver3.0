import { randomUUID } from 'crypto';
import { create as createExifParser } from 'exif-parser';
import { getLogger } from '../config/logger';
import {
  findGeofenceByProjectId,
  type GpsCoordinate
} from '../models/projectGeofenceModel';
import {
  createOracleVerificationResult,
  linkOverrideRequestToVerification
} from '../models/oracleVerificationResultModel';
import {
  createOracleOverrideRequest
} from '../models/oracleOverrideRequestModel';
import { findActiveCommissioners } from '../models/authModel';
import { createUserNotification } from './notificationService';
import {
  oracleEvents,
  type OracleVerifiedEventPayload,
  type OverrideRequestedEventPayload
} from '../events/oracleEvents';

const logger = getLogger();

/** Max file size 10MB (bytes). */
export const ORACLE_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Bán kính mặc định khi project chưa có geofence (dùng cho placeholder record). */
const DEFAULT_RADIUS_METERS = 500;

/** Bán kính tối đa và tối thiểu theo spec. */
const MAX_RADIUS_METERS = 2000;
const MIN_RADIUS_METERS = 100;

/**
 * Kết quả xác minh từ oracle service.
 * isValid = true  : trong phạm vi geofence
 * isValid = false : ngoài phạm vi → cần override vote
 * isValid = null  : không có GPS hoặc chưa có geofence → cần override vote
 */
export type OracleVerificationResult = {
  isValid: boolean | null;
  distance: number | null;
  reason: string | null;
  verificationId: string;
  overrideRequestId: string | null;
};

/**
 * Trích xuất tọa độ GPS từ EXIF metadata của ảnh.
 * Trả về null nếu ảnh không có GPS data (bị strip bởi Zalo, Facebook, v.v.).
 * DMS → Decimal degrees: exif-parser với enableSimpleValues(true).
 */
export function extractExifGps(buffer: Buffer): GpsCoordinate | null {
  try {
    const parser = createExifParser(buffer).enableSimpleValues(true);
    const result = parser.parse();
    const tags = result.tags;

    if (
      typeof tags.GPSLatitude !== 'number' ||
      typeof tags.GPSLongitude !== 'number'
    ) {
      return null;
    }

    let lat = tags.GPSLatitude;
    let lng = tags.GPSLongitude;

    // exif-parser với enableSimpleValues đã convert DMS→decimal,
    // nhưng sign phụ thuộc vào GPSLatitudeRef/GPSLongitudeRef.
    if (tags.GPSLatitudeRef === 'S') lat = -Math.abs(lat);
    if (tags.GPSLongitudeRef === 'W') lng = -Math.abs(lng);

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      logger.warn('EXIF GPS ngoài phạm vi hợp lệ.', { errorMessage: `lat=${lat}, lng=${lng}` });
      return null;
    }

    return { lat, lng };
  } catch (error) {
    logger.info('Không thể parse EXIF từ ảnh (có thể không phải JPEG/TIFF).', {
      errorMessage: (error as Error)?.message
    });
    return null;
  }
}

/**
 * Tính khoảng cách giữa 2 tọa độ GPS bằng công thức Haversine.
 * Sai số < 0.1% với khoảng cách < 10km (đủ cho bài toán geofence 2km max).
 * Bán kính Trái Đất: 6371000m (WGS-84 mean radius).
 *
 * @returns Khoảng cách tính bằng mét.
 */
export function haversineDistance(a: GpsCoordinate, b: GpsCoordinate): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Lấy danh sách commissioner hiện tại (role admin + regulatory, chỉ ACTIVE).
 * Dùng để tạo commissionerSnapshot khi có override request.
 * Query sau mỗi request để đảm bảo snapshot phản ánh đúng trạng thái hệ thống tại thời điểm tạo.
 */
async function fetchCommissionerSnapshot(): Promise<Array<{ userId: string; role: string }>> {
  const commissioners = await findActiveCommissioners();
  return commissioners.map(u => ({ userId: u.id, role: u.role }));
}

/**
 * Hàm chính: xác minh ảnh minh chứng cho một dự án.
 *
 * Flow:
 * 1. Lấy geofence của project
 * 2. Parse EXIF GPS từ buffer ảnh
 * 3. Tính Haversine distance
 * 4. Ghi kết quả theo thứ tự: verification → override → link (verification-first)
 * 5. Populate commissionerSnapshot vào override request
 * 6. Emit oracle.verified + override.requested events
 *
 * Thứ tự ghi verification-first giúp crash recovery:
 * - Crash trước khi tạo override → verification orphaned (không hiện trong admin UI)
 * - Crash trước khi link → detectable qua query verificationId trên override collection
 *
 * @param buffer                - Buffer ảnh JPEG/PNG/WebP (max 10MB đã validate ở controller)
 * @param projectId             - ID dự án cần verify
 * @param organizationId        - ID tổ chức upload ảnh (userId từ JWT)
 * @param evidenceCid           - IPFS CID của ảnh
 * @param disbursementRequestId - ID yêu cầu giải ngân liên quan (null nếu upload độc lập)
 */
export async function verifyEvidenceImage(
  buffer: Buffer,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  disbursementRequestId: string | null = null
): Promise<OracleVerificationResult> {
  const verificationId = randomUUID();

  // Bước 1: Lấy geofence của project
  const geofence = await findGeofenceByProjectId(projectId);
  if (!geofence) {
    logger.warn('Project chưa có geofence. Tạo override NO_GEOFENCE.', { projectId, verificationId });
    return await handleNoGeofence(verificationId, projectId, organizationId, evidenceCid, buffer, disbursementRequestId);
  }

  // Clamp radius: floor 100m và cap 2000m theo spec, bảo vệ khỏi giá trị DB không hợp lệ
  const radiusMeters = Math.min(Math.max(geofence.radiusMeters, MIN_RADIUS_METERS), MAX_RADIUS_METERS);
  const projectCentroid = geofence.centroid;

  // Bước 2: Trích xuất EXIF GPS
  const gpsFromImage = extractExifGps(buffer);

  // THIẾT KẾ — Circular approximation: xác minh dùng khoảng cách Haversine từ GPS ảnh tới centroid.
  // Geofence.polygon chỉ dùng để hiển thị trên bản đồ (B3 GeofenceMap), không dùng cho verification.
  // Điều này có nghĩa: điểm trong polygon nhưng ngoài vòng tròn → INVALID (và ngược lại).
  // Chấp nhận sai số này vì polygon thường là convex quanh centroid và radius được chọn bao phủ polygon.
  // Nếu cần chính xác hơn: implement point-in-polygon (ray casting) thay thế.

  if (!gpsFromImage) {
    return await handleNoGps(
      verificationId, projectId, organizationId, evidenceCid,
      projectCentroid, radiusMeters, disbursementRequestId
    );
  }

  // Bước 3: Haversine distance
  const distanceMeters = haversineDistance(gpsFromImage, projectCentroid);
  const isInRadius = distanceMeters <= radiusMeters;

  logger.info('Oracle verification kết quả.', {
    verificationId,
    projectId,
    distanceMeters: distanceMeters.toFixed(2),
    radiusMeters,
    isInRadius
  });

  if (isInRadius) {
    return await handleValid(
      verificationId, projectId, organizationId, evidenceCid,
      gpsFromImage, projectCentroid, distanceMeters, radiusMeters
    );
  } else {
    return await handleOutOfGeofence(
      verificationId, projectId, organizationId, evidenceCid,
      gpsFromImage, projectCentroid, distanceMeters, radiusMeters, disbursementRequestId
    );
  }
}

/** Xử lý ảnh GPS hợp lệ và trong phạm vi geofence. */
async function handleValid(
  verificationId: string,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  gpsFromImage: GpsCoordinate,
  gpsFromProject: GpsCoordinate,
  distanceMeters: number,
  radiusMeters: number
): Promise<OracleVerificationResult> {
  await createOracleVerificationResult({
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    status: 'VALID',
    gpsFromImage,
    gpsFromProject,
    distanceMeters,
    radiusMeters,
    overrideRequestId: null,
    processedAt: new Date()
  });

  oracleEvents.emit('oracle.verified', {
    verificationId, projectId, organizationId, evidenceCid,
    isValid: true, distance: distanceMeters, reason: null
  } satisfies OracleVerifiedEventPayload);

  return { isValid: true, distance: distanceMeters, reason: null, verificationId, overrideRequestId: null };
}

/**
 * Xử lý GPS ngoài phạm vi geofence.
 *
 * Thứ tự ghi: verification trước → override sau → link → snapshot.
 * Nếu crash sau bước verification: orphaned verification (overrideRequestId=null, không hiện admin UI).
 * Nếu crash sau bước override: missing link — recoverable bằng query override theo verificationId.
 * TODO: cron job kiểm tra oracle_verification_results.overrideRequestId=null & status≠VALID để phát hiện partial writes.
 */
async function handleOutOfGeofence(
  verificationId: string,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  gpsFromImage: GpsCoordinate,
  gpsFromProject: GpsCoordinate,
  distanceMeters: number,
  radiusMeters: number,
  disbursementRequestId: string | null
): Promise<OracleVerificationResult> {
  // Bước 1: tạo verification (overrideRequestId=null sẽ được link ở bước 3)
  await createOracleVerificationResult({
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    status: 'INVALID',
    gpsFromImage,
    gpsFromProject,
    distanceMeters,
    radiusMeters,
    overrideRequestId: null,
    processedAt: new Date()
  });

  // Bước 2: fetch commissioner snapshot TRƯỚC khi tạo override để tránh race window (snapshot rỗng)
  const commissionerSnapshot = await fetchCommissionerSnapshot();

  // Bước 3: tạo override request với snapshot đã populate
  const overrideRequestId = randomUUID();
  await createOracleOverrideRequest({
    overrideRequestId,
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    disbursementRequestId,
    reason: 'OUT_OF_GEOFENCE',
    gpsFromImage,
    gpsFromProject,
    distanceMeters,
    commissionerSnapshot
  });

  // Bước 4: link override vào verification
  await linkOverrideRequestToVerification(verificationId, overrideRequestId);

  // Bước 5: notify từng commissioner trong snapshot để họ vào vote
  await notifyCommissionersOverrideCreated(commissionerSnapshot, overrideRequestId, projectId, 'OUT_OF_GEOFENCE');

  logger.warn('Oracle: GPS ngoài phạm vi. Override request đã tạo.', {
    verificationId, projectId,
    distanceMeters: distanceMeters.toFixed(2),
    radiusMeters, overrideRequestId
  });

  emitVerifiedAndOverride(
    verificationId, projectId, organizationId, evidenceCid,
    false, distanceMeters, 'Out of geofence',
    overrideRequestId, gpsFromImage, gpsFromProject, distanceMeters,
    'OUT_OF_GEOFENCE', commissionerSnapshot.length
  );

  return { isValid: false, distance: distanceMeters, reason: 'Out of geofence', verificationId, overrideRequestId };
}

/**
 * Xử lý ảnh không có EXIF GPS → override với flag GPS_EXIF_MISSING.
 * Cùng thứ tự verification-first với handleOutOfGeofence.
 */
async function handleNoGps(
  verificationId: string,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  gpsFromProject: GpsCoordinate,
  radiusMeters: number,
  disbursementRequestId: string | null
): Promise<OracleVerificationResult> {
  await createOracleVerificationResult({
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    status: 'NO_GPS',
    gpsFromImage: null,
    gpsFromProject,
    distanceMeters: null,
    radiusMeters,
    overrideRequestId: null,
    processedAt: new Date()
  });

  const commissionerSnapshot = await fetchCommissionerSnapshot();

  const overrideRequestId = randomUUID();
  await createOracleOverrideRequest({
    overrideRequestId,
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    disbursementRequestId,
    reason: 'GPS_EXIF_MISSING',
    gpsFromImage: null,
    gpsFromProject,
    distanceMeters: null,
    commissionerSnapshot
  });

  await linkOverrideRequestToVerification(verificationId, overrideRequestId);

  await notifyCommissionersOverrideCreated(commissionerSnapshot, overrideRequestId, projectId, 'GPS_EXIF_MISSING');

  logger.warn('Oracle: Ảnh không có EXIF GPS. Override NO_GPS đã tạo.', {
    verificationId, projectId, overrideRequestId
  });

  emitVerifiedAndOverride(
    verificationId, projectId, organizationId, evidenceCid,
    null, null, 'GPS_EXIF_MISSING',
    overrideRequestId, null, gpsFromProject, null,
    'GPS_EXIF_MISSING', commissionerSnapshot.length
  );

  return { isValid: null, distance: null, reason: 'GPS_EXIF_MISSING', verificationId, overrideRequestId };
}

/**
 * Xử lý project chưa có geofence → override với flag NO_GEOFENCE.
 * Parse EXIF trước để ghi nhận GPS thực tế của ảnh (nếu có) — dữ liệu hữu ích cho admin khi review.
 * Khác GPS_EXIF_MISSING: ảnh có thể có GPS hợp lệ, chỉ là project chưa cài geofence.
 */
async function handleNoGeofence(
  verificationId: string,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  buffer: Buffer,
  disbursementRequestId: string | null
): Promise<OracleVerificationResult> {
  // Parse EXIF ngay cả khi không có geofence — ghi nhận GPS thực tế để admin có thể review
  const gpsFromImage = extractExifGps(buffer);
  // Centroid (0,0) là placeholder — admin sẽ thấy trong override queue với lý do NO_GEOFENCE
  const placeholderCentroid: GpsCoordinate = { lat: 0, lng: 0 };

  await createOracleVerificationResult({
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    status: 'NO_GEOFENCE',
    gpsFromImage,
    gpsFromProject: placeholderCentroid,
    distanceMeters: null,
    radiusMeters: DEFAULT_RADIUS_METERS,
    overrideRequestId: null,
    processedAt: new Date()
  });

  const commissionerSnapshot = await fetchCommissionerSnapshot();

  const overrideRequestId = randomUUID();
  await createOracleOverrideRequest({
    overrideRequestId,
    verificationId,
    projectId,
    organizationId,
    evidenceCid,
    disbursementRequestId,
    reason: 'NO_GEOFENCE',
    gpsFromImage,
    gpsFromProject: placeholderCentroid,
    distanceMeters: null,
    commissionerSnapshot
  });

  await linkOverrideRequestToVerification(verificationId, overrideRequestId);

  await notifyCommissionersOverrideCreated(commissionerSnapshot, overrideRequestId, projectId, 'NO_GEOFENCE');

  logger.warn('Oracle: Project chưa có geofence. Override NO_GEOFENCE đã tạo.', {
    verificationId, projectId, overrideRequestId,
    gpsFoundInImage: gpsFromImage !== null
  });

  emitVerifiedAndOverride(
    verificationId, projectId, organizationId, evidenceCid,
    null, null, 'NO_GEOFENCE',
    overrideRequestId, gpsFromImage, placeholderCentroid, null,
    'NO_GEOFENCE', commissionerSnapshot.length
  );

  return { isValid: null, distance: null, reason: 'NO_GEOFENCE', verificationId, overrideRequestId };
}

/**
 * Gửi notification đến từng commissioner trong snapshot khi override request mới được tạo.
 * Thất bại gửi notification không block quá trình tạo override — log và tiếp tục.
 */
async function notifyCommissionersOverrideCreated(
  commissionerSnapshot: Array<{ userId: string; role: string }>,
  overrideRequestId: string,
  projectId: string,
  reason: string
): Promise<void> {
  const reasonLabel: Record<string, string> = {
    OUT_OF_GEOFENCE: 'GPS ngoài phạm vi địa lý',
    GPS_EXIF_MISSING: 'Ảnh thiếu dữ liệu GPS',
    NO_GEOFENCE: 'Dự án chưa cài đặt vùng địa lý'
  };

  const notifyPromises = commissionerSnapshot.map(({ userId }) =>
    createUserNotification({
      userId,
      notificationType: 'SYSTEM',
      title: 'Yêu cầu ghi đè GPS cần biểu quyết',
      content: `Dự án ${projectId} có yêu cầu ghi đè GPS mới cần biểu quyết: ${reasonLabel[reason] ?? reason}. Vui lòng vào hệ thống để xem xét.`,
      metadata: { overrideRequestId, projectId, reason },
      deduplicationKey: `override-created-${overrideRequestId}-${userId}`
    }).catch((err: Error) => {
      logger.error('Gửi notification tạo override thất bại cho commissioner.', {
        overrideRequestId, authenticatedUserId: userId, errorMessage: err.message
      });
    })
  );

  await Promise.allSettled(notifyPromises);
}

/** Emit cả oracle.verified và override.requested trong một lần gọi. */
function emitVerifiedAndOverride(
  verificationId: string,
  projectId: string,
  organizationId: string,
  evidenceCid: string,
  isValid: boolean | null,
  distance: number | null,
  verifiedReason: string,
  overrideRequestId: string,
  gpsFromImage: GpsCoordinate | null,
  gpsFromProject: GpsCoordinate,
  distanceMeters: number | null,
  overrideReason: 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE',
  commissionerCount: number
): void {
  oracleEvents.emit('oracle.verified', {
    verificationId, projectId, organizationId, evidenceCid,
    isValid, distance, reason: verifiedReason
  } satisfies OracleVerifiedEventPayload);

  oracleEvents.emit('override.requested', {
    overrideRequestId, projectId, organizationId, evidenceCid,
    gpsFromImage, gpsFromProject, distance: distanceMeters,
    reason: overrideReason, commissionerCount
  } satisfies OverrideRequestedEventPayload);
}
