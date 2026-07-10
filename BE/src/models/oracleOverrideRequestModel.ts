import mongoose, { Schema } from 'mongoose';
import type { GpsCoordinate } from './projectGeofenceModel';

/**
 * Trạng thái yêu cầu ghi đè GPS.
 * PENDING: chờ tất cả commissioner trong snapshot vote
 * APPROVED: đủ N/N vote APPROVE → cho phép giải ngân
 * REJECTED: ít nhất 1 vote REJECT → từ chối giải ngân
 * EXPIRED: commissioner set thay đổi sau khi tạo request → phải tạo lại
 */
export type OverrideRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

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
 * Voting: tất cả commissioner trong snapshot phải vote, cần 100% APPROVE để pass.
 */
export type OracleOverrideRequestRecord = {
  overrideRequestId: string;            // UUID
  verificationId: string;               // Liên kết đến oracle_verification_results
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  /**
   * Link disbursement request tương ứng để auto-approve khi tất cả vote APPROVE.
   * null nếu verification được trigger từ batch endpoint (không liên quan disbursement).
   */
  disbursementRequestId: string | null;
  reason: OverrideReason;
  gpsFromImage: GpsCoordinate | null;   // null khi reason=GPS_EXIF_MISSING
  gpsFromProject: GpsCoordinate;
  distanceMeters: number | null;        // null khi reason=GPS_EXIF_MISSING
  // Snapshot commissioners tại thời điểm tạo request — dùng để check 403 và detect thay đổi
  commissionerSnapshot: Array<{ userId: string; role: string }>;
  votes: CommissionerVote[];
  status: OverrideRequestStatus;
  resolvedAt: Date | null;
  expiredAt: Date | null;               // Set khi EXPIRED do commissioner set thay đổi hoặc timeout
  createdAt: Date;
  updatedAt: Date;
};

const gpsCoordinateSchema = new Schema<GpsCoordinate>(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

// [B2-fix #4] Thêm enum constraint cho commissionerRole — ngăn role không hợp lệ lọt vào DB
const commissionerVoteSchema = new Schema<CommissionerVote>(
  {
    commissionerId: { type: String, required: true },
    commissionerRole: { type: String, required: true, enum: ['admin', 'regulatory'] },
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
    disbursementRequestId: { type: String, default: null, index: true, sparse: true },
    reason: { type: String, required: true, enum: ['OUT_OF_GEOFENCE', 'GPS_EXIF_MISSING', 'NO_GEOFENCE'] },
    gpsFromImage: { type: gpsCoordinateSchema, default: null },
    gpsFromProject: { type: gpsCoordinateSchema, required: true },
    distanceMeters: { type: Number, default: null },
    // [B2-fix #4] Enum constraint cho role trong snapshot — đảm bảo data integrity ở tầng DB
    commissionerSnapshot: {
      type: [{
        userId: { type: String, required: true },
        role: { type: String, required: true, enum: ['admin', 'regulatory'] }
      }],
      default: []
    },
    votes: { type: [commissionerVoteSchema], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
      default: 'PENDING',
      index: true
    },
    resolvedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null }
  },
  { timestamps: true }
);

oracleOverrideRequestSchema.index({ projectId: 1, status: 1 });
oracleOverrideRequestSchema.index({ organizationId: 1, status: 1 });
// [B2-fix N4] Compound index để sort PENDING theo createdAt không phải scan toàn bộ
oracleOverrideRequestSchema.index({ status: 1, createdAt: -1 });

const OracleOverrideRequestMongoModel = mongoose.model<OracleOverrideRequestRecord>(
  'OracleOverrideRequest',
  oracleOverrideRequestSchema,
  'oracle_override_requests'
);

/** Tạo override request mới (PENDING). expiredAt, resolvedAt, votes, status được set mặc định. */
export async function createOracleOverrideRequest(
  data: Omit<OracleOverrideRequestRecord, 'createdAt' | 'updatedAt' | 'votes' | 'status' | 'resolvedAt' | 'expiredAt'>
): Promise<OracleOverrideRequestRecord> {
  const doc = await OracleOverrideRequestMongoModel.create({
    ...data,
    votes: [],
    status: 'PENDING',
    resolvedAt: null
  });
  return doc.toObject();
}

/**
 * Tìm một commissioner entry trong snapshot của override request theo userId.
 * Trả về { userId, role } nếu tìm thấy, null nếu không.
 * [B4-fix #2] Hỗ trợ validate role khớp với snapshot, ngăn IDOR.
 */
export async function findCommissionerInSnapshot(
  overrideRequestId: string,
  userId: string
): Promise<{ userId: string; role: string } | null> {
  const doc = await OracleOverrideRequestMongoModel.findOne(
    { overrideRequestId, 'commissionerSnapshot.userId': userId },
    { 'commissionerSnapshot.$': 1 }
  ).lean<{ commissionerSnapshot: Array<{ userId: string; role: string }> }>().exec();
  return doc?.commissionerSnapshot?.[0] ?? null;
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
 * Lấy danh sách override request PENDING tạo trước ngưỡng thời gian (dùng cho expiry worker).
 * [B2-fix #7] Dùng compound index {status:1, createdAt:-1} để query hiệu quả.
 */
export async function findPendingOverrideRequestsExpiredBefore(
  cutoff: Date
): Promise<OracleOverrideRequestRecord[]> {
  return OracleOverrideRequestMongoModel.find({
    status: 'PENDING',
    createdAt: { $lt: cutoff }
  })
    .sort({ createdAt: 1 })
    .limit(100) // Giới hạn 100 để tránh quá tải trong 1 chu kỳ
    .lean()
    .exec();
}

/**
 * Xóa override request theo ID — dùng để cleanup khi ghi verification thất bại.
 * Không throw nếu record không tồn tại.
 */
export async function deleteOracleOverrideRequestById(overrideRequestId: string): Promise<void> {
  await OracleOverrideRequestMongoModel.deleteOne({ overrideRequestId }).exec();
}

/**
 * Thêm vote của một commissioner vào danh sách votes.
 * Dùng $push atomic để tránh race condition khi nhiều commissioner vote cùng lúc.
 * Trả về record sau khi cập nhật, null nếu không tìm thấy.
 */
export async function addVoteToOverrideRequest(
  overrideRequestId: string,
  vote: CommissionerVote
): Promise<OracleOverrideRequestRecord | null> {
  const updated = await OracleOverrideRequestMongoModel.findOneAndUpdate(
    { overrideRequestId, status: 'PENDING' },
    { $push: { votes: vote } },
    { returnDocument: 'after' }
  ).lean<OracleOverrideRequestRecord>().exec();
  return updated ?? null;
}

/**
 * Cập nhật trạng thái override request sang APPROVED hoặc REJECTED khi đủ điều kiện.
 * Chỉ cập nhật khi status hiện tại vẫn là PENDING (tránh double-resolve).
 */
export async function resolveOverrideRequest(
  overrideRequestId: string,
  newStatus: 'APPROVED' | 'REJECTED',
  resolvedAt: Date
): Promise<OracleOverrideRequestRecord | null> {
  const updated = await OracleOverrideRequestMongoModel.findOneAndUpdate(
    { overrideRequestId, status: 'PENDING' },
    { $set: { status: newStatus, resolvedAt } },
    { returnDocument: 'after' }
  ).lean<OracleOverrideRequestRecord>().exec();
  return updated ?? null;
}

/**
 * Expire override request khi phát hiện commissioner set thay đổi.
 * Chỉ expire nếu status còn PENDING.
 */
export async function expireOverrideRequest(
  overrideRequestId: string,
  expiredAt: Date
): Promise<OracleOverrideRequestRecord | null> {
  const updated = await OracleOverrideRequestMongoModel.findOneAndUpdate(
    { overrideRequestId, status: 'PENDING' },
    { $set: { status: 'EXPIRED', expiredAt } },
    { returnDocument: 'after' }
  ).lean<OracleOverrideRequestRecord>().exec();
  return updated ?? null;
}

