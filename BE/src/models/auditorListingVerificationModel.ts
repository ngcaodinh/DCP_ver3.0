import crypto from 'crypto';
import mongoose, { type ClientSession, Schema } from 'mongoose';

export interface AuditorListingVerificationPhoto {
  cid: string;
  contentSha256: string;
  fileName: string;
  mimeType: 'image/jpeg';
  gps: { latitude: number; longitude: number };
  accuracyMeters: number;
  isLowAccuracyOverride: boolean;
  overrideUnlockedAfterMs: number | null;
  lowAccuracyReason: string | null;
  capturedAt: Date;
  capturedAtClient: Date;
  geolocationTimestamp: string;
  clockSkewSeconds: number;
}

/**
 * Bản ghi xác minh tích cực trong cửa sổ niêm yết 48h.
 * Chỉ chứa kết luận CONFIRMED — kết luận "sai sự thật" đi đường khiếu nại để mở vụ xét xử.
 * Mục đích: phân biệt "đã đi kiểm tra và thấy đúng" với "không ai đi kiểm tra", vì cơ chế
 * Niêm yết Lạc quan coi cả hai đều là im lặng và tự kích hoạt dự án sau 48 giờ.
 */
export interface AuditorListingVerificationRecord {
  verificationId: string;
  projectId: string;
  round: number;
  auditorUserId: string;
  verdict: 'CONFIRMED';
  note: string | null;
  photos: AuditorListingVerificationPhoto[];
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const gpsSchema = new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 }, longitude: { type: Number, required: true, min: -180, max: 180 } }, { _id: false });
const verificationPhotoSchema = new Schema<AuditorListingVerificationPhoto>({
  cid: { type: String, required: true }, contentSha256: { type: String, required: true }, fileName: { type: String, required: true }, mimeType: { type: String, enum: ['image/jpeg'], required: true },
  gps: { type: gpsSchema, required: true }, accuracyMeters: { type: Number, required: true, min: 0 }, isLowAccuracyOverride: { type: Boolean, required: true },
  overrideUnlockedAfterMs: { type: Number, default: null }, lowAccuracyReason: { type: String, default: null }, capturedAt: { type: Date, required: true },
  capturedAtClient: { type: Date, required: true }, geolocationTimestamp: { type: String, required: true }, clockSkewSeconds: { type: Number, required: true }
}, { _id: false, strict: 'throw' });
const auditorListingVerificationSchema = new Schema<AuditorListingVerificationRecord>({
  verificationId: { type: String, required: true, unique: true }, projectId: { type: String, required: true }, round: { type: Number, required: true, min: 1 },
  auditorUserId: { type: String, required: true }, verdict: { type: String, enum: ['CONFIRMED'], required: true },
  note: { type: String, default: null }, photos: { type: [verificationPhotoSchema], required: true },
  submittedAt: { type: Date, required: true }, createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true }
}, { collection: 'auditor_listing_verifications', strict: 'throw' });

auditorListingVerificationSchema.index({ projectId: 1, round: 1, auditorUserId: 1 }, { unique: true });
auditorListingVerificationSchema.index({ auditorUserId: 1, submittedAt: -1 });
auditorListingVerificationSchema.index({ projectId: 1, round: 1 });

export const AuditorListingVerificationMongoModel = mongoose.models?.AuditorListingVerification
  || mongoose.model<AuditorListingVerificationRecord>('AuditorListingVerification', auditorListingVerificationSchema);

/** Tạo bản ghi xác minh với định danh ngẫu nhiên để truy vết độc lập với Mongo ObjectId. */
export async function createAuditorListingVerification(
  payload: Omit<AuditorListingVerificationRecord, 'verificationId' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<AuditorListingVerificationRecord> {
  const now = new Date();
  const created = await AuditorListingVerificationMongoModel.create([{
    ...payload, verificationId: crypto.randomUUID(), createdAt: now, updatedAt: now
  }], session ? { session } : undefined);
  return created[0].toObject() as AuditorListingVerificationRecord;
}

/** Chặn một auditor xác minh hai lần trong cùng vòng niêm yết. */
export async function findListingVerificationByProjectRoundAndUser(
  projectId: string,
  round: number,
  auditorUserId: string
): Promise<AuditorListingVerificationRecord | null> {
  return AuditorListingVerificationMongoModel.findOne({ projectId, round, auditorUserId }).lean<AuditorListingVerificationRecord>().exec();
}

/** Liệt kê xác minh của chính auditor cho màn hình lịch sử, luôn có trần bản ghi. */
export async function findListingVerificationsByAuditorUserId(
  auditorUserId: string,
  limitCount: number
): Promise<AuditorListingVerificationRecord[]> {
  return AuditorListingVerificationMongoModel.find({ auditorUserId })
    .sort({ submittedAt: -1 })
    .limit(limitCount)
    .lean<AuditorListingVerificationRecord[]>()
    .exec();
}
