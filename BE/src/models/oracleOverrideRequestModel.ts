import mongoose, { Schema } from 'mongoose';
import type { GpsCoordinate } from './projectGeofenceModel';

/**
 * Trạng thái yêu cầu ghi đè GPS.
 * PENDING: chờ 3/3 commissioner vote
 * APPROVED: đủ 3/3 vote APPROVE → cho phép giải ngân
 * REJECTED: ít nhất 1 vote REJECT → từ chối giải ngân
 */
export type OverrideRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Lý do tạo override request.
 * NO_GEOFENCE: project chưa cài đặt geofence — admin cần setup hoặc approve thủ công.
 */
export type OverrideReason = 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE';

/**
 * Một phiếu biểu quyết của commissioner.
 */
export type CommissionerVote = {
  commissionerId: string;
  commissionerRole: string;     // Snapshot role tại thời điểm tạo request
  vote: 'APPROVE' | 'REJECT';
  reason: string;
  votedAt: Date;
};

/**
 * Yêu cầu ghi đè GPS — tạo khi Oracle phát hiện ảnh ngoài geofence hoặc thiếu EXIF GPS.
 * B2 sẽ implement voting logic (3/3 multisig).
 */
export type OracleOverrideRequestRecord = {
  overrideRequestId: string;            // UUID
  verificationId: string;               // Liên kết đến oracle_verification_results
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  reason: OverrideReason;
  gpsFromImage: GpsCoordinate | null;   // null khi reason=GPS_EXIF_MISSING
  gpsFromProject: GpsCoordinate;
  distanceMeters: number | null;        // null khi reason=GPS_EXIF_MISSING
  // Snapshot commissioners tại thời điểm tạo request (B2 populate)
  commissionerSnapshot: Array<{ userId: string; role: string }>;
  votes: CommissionerVote[];
  status: OverrideRequestStatus;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const gpsCoordinateSchema = new Schema<GpsCoordinate>(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

const commissionerVoteSchema = new Schema<CommissionerVote>(
  {
    commissionerId: { type: String, required: true },
    commissionerRole: { type: String, required: true },
    vote: { type: String, required: true, enum: ['APPROVE', 'REJECT'] },
    reason: { type: String, required: true },
    votedAt: { type: Date, required: true }
  },
  { _id: false }
);

const oracleOverrideRequestSchema = new Schema<OracleOverrideRequestRecord>(
  {
    overrideRequestId: { type: String, required: true, unique: true },
    verificationId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    evidenceCid: { type: String, required: true },
    reason: { type: String, required: true, enum: ['OUT_OF_GEOFENCE', 'GPS_EXIF_MISSING', 'NO_GEOFENCE'] },
    gpsFromImage: { type: gpsCoordinateSchema, default: null },
    gpsFromProject: { type: gpsCoordinateSchema, required: true },
    distanceMeters: { type: Number, default: null },
    commissionerSnapshot: {
      type: [{ userId: String, role: String }],
      default: []
    },
    votes: { type: [commissionerVoteSchema], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true
    },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

oracleOverrideRequestSchema.index({ projectId: 1, status: 1 });
oracleOverrideRequestSchema.index({ organizationId: 1, status: 1 });

const OracleOverrideRequestMongoModel = mongoose.model<OracleOverrideRequestRecord>(
  'OracleOverrideRequest',
  oracleOverrideRequestSchema,
  'oracle_override_requests'
);

/** Tạo override request mới (PENDING). */
export async function createOracleOverrideRequest(
  data: Omit<OracleOverrideRequestRecord, 'createdAt' | 'updatedAt' | 'votes' | 'status' | 'resolvedAt'>
): Promise<OracleOverrideRequestRecord> {
  const doc = await OracleOverrideRequestMongoModel.create({
    ...data,
    votes: [],
    status: 'PENDING',
    resolvedAt: null
  });
  return doc.toObject();
}

/** Lấy override request theo ID. */
export async function findOverrideRequestById(
  overrideRequestId: string
): Promise<OracleOverrideRequestRecord | null> {
  return OracleOverrideRequestMongoModel.findOne({ overrideRequestId }).lean().exec();
}

/** Lấy danh sách override request đang PENDING (dùng cho B2 admin UI). */
export async function findPendingOverrideRequests(
  limit = 20,
  skip = 0
): Promise<OracleOverrideRequestRecord[]> {
  return OracleOverrideRequestMongoModel.find({ status: 'PENDING' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}

/** Đếm số override request PENDING (B2 cần cho badge count). */
export async function countPendingOverrideRequests(): Promise<number> {
  return OracleOverrideRequestMongoModel.countDocuments({ status: 'PENDING' }).exec();
}

/**
 * Xóa override request theo ID — dùng để cleanup khi ghi verification thất bại.
 * Không throw nếu record không tồn tại.
 */
export async function deleteOracleOverrideRequestById(overrideRequestId: string): Promise<void> {
  await OracleOverrideRequestMongoModel.deleteOne({ overrideRequestId }).exec();
}
