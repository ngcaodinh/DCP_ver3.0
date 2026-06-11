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
  overrideRequestId: string | null;      // Liên kết đến oracle_override_requests nếu có
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const gpsCoordinateSchema = new Schema<GpsCoordinate>(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
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
