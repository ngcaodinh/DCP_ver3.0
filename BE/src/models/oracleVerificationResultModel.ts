import mongoose, { Schema } from 'mongoose';
import type { GpsCoordinate } from './projectGeofenceModel';

/**
 * Kết quả xác minh Oracle.
 * VALID: trong bán kính geofence
 * INVALID: ngoài bán kính → trigger override request
 * NO_GPS: ảnh không có EXIF GPS → trigger override request với flag NO_GPS
 * NO_GEOFENCE: project chưa cài đặt geofence → trigger override request
 */
export type OracleVerificationStatus = 'VALID' | 'INVALID' | 'NO_GPS' | 'NO_GEOFENCE';

/**
 * Ảnh chụp bất biến của geofence tại đúng thời điểm Oracle xác minh (B3).
 * Lưu polygon, centroid và bán kính đã dùng để verify — dùng cho Admin/Regulatory
 * review lại trên bản đồ mà không bị ảnh hưởng khi Organization sửa geofence sau này.
 * null khi project chưa có geofence (status NO_GEOFENCE).
 */
export type GeofenceSnapshot = {
  polygon: GpsCoordinate[];   // Vùng ranh giới tại thời điểm verify
  centroid: GpsCoordinate;    // Tâm polygon dùng làm điểm tham chiếu Haversine
  radiusMeters: number;       // Bán kính đã clamp thực sự dùng để verify
};

/**
 * Bản ghi kết quả xác minh EXIF GPS của ảnh minh chứng.
 */
export type OracleVerificationResultRecord = {
  verificationId: string;                // UUID
  projectId: string;
  organizationId: string;
  evidenceCid: string;                   // IPFS CID của ảnh được verify
  status: OracleVerificationStatus;
  gpsFromImage: GpsCoordinate | null;    // Tọa độ từ EXIF, null nếu bị strip
  gpsFromProject: GpsCoordinate;         // Centroid geofence của project
  distanceMeters: number | null;         // Khoảng cách Haversine (mét), null nếu NO_GPS
  radiusMeters: number;                  // Bán kính per-project tại thời điểm verify
  geofenceSnapshot: GeofenceSnapshot | null; // Ảnh chụp geofence bất biến lúc verify (B3), null khi NO_GEOFENCE
  overrideRequestId: string | null;      // Liên kết đến oracle_override_requests nếu có
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const gpsCoordinateSchema = new Schema<GpsCoordinate>(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

// Sub-schema cho geofence snapshot bất biến (B3) — lưu nguyên trạng lúc verify
const geofenceSnapshotSchema = new Schema<GeofenceSnapshot>(
  {
    polygon: { type: [gpsCoordinateSchema], required: true },
    centroid: { type: gpsCoordinateSchema, required: true },
    radiusMeters: { type: Number, required: true }
  },
  { _id: false }
);

const oracleVerificationResultSchema = new Schema<OracleVerificationResultRecord>(
  {
    verificationId: { type: String, required: true, unique: true },
    projectId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    evidenceCid: { type: String, required: true },
    status: { type: String, required: true, enum: ['VALID', 'INVALID', 'NO_GPS', 'NO_GEOFENCE'] },
    gpsFromImage: { type: gpsCoordinateSchema, default: null },
    gpsFromProject: { type: gpsCoordinateSchema, required: true },
    distanceMeters: { type: Number, default: null },
    radiusMeters: { type: Number, required: true },
    // Snapshot bất biến của geofence lúc verify — null khi project chưa có geofence
    geofenceSnapshot: { type: geofenceSnapshotSchema, default: null },
    overrideRequestId: { type: String, default: null, index: true },
    processedAt: { type: Date, required: true }
  },
  { timestamps: true }
);

oracleVerificationResultSchema.index({ projectId: 1, evidenceCid: 1 });
oracleVerificationResultSchema.index({ organizationId: 1, status: 1 });

const OracleVerificationResultMongoModel = mongoose.model<OracleVerificationResultRecord>(
  'OracleVerificationResult',
  oracleVerificationResultSchema,
  'oracle_verification_results'
);

/** Lưu kết quả xác minh mới. */
export async function createOracleVerificationResult(
  data: Omit<OracleVerificationResultRecord, 'createdAt' | 'updatedAt'>
): Promise<OracleVerificationResultRecord> {
  const doc = await OracleVerificationResultMongoModel.create(data);
  return doc.toObject();
}

/** Cập nhật overrideRequestId sau khi override request được tạo. */
export async function linkOverrideRequestToVerification(
  verificationId: string,
  overrideRequestId: string
): Promise<void> {
  await OracleVerificationResultMongoModel.updateOne(
    { verificationId },
    { $set: { overrideRequestId } }
  ).exec();
}

/** Lấy kết quả xác minh theo verificationId. */
export async function findVerificationById(
  verificationId: string
): Promise<OracleVerificationResultRecord | null> {
  return OracleVerificationResultMongoModel.findOne({ verificationId }).lean().exec();
}

/** Lấy danh sách kết quả xác minh của một project (phân trang). */
export async function findVerificationsByProjectId(
  projectId: string,
  limit = 20,
  skip = 0
): Promise<OracleVerificationResultRecord[]> {
  return OracleVerificationResultMongoModel.find({ projectId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}
