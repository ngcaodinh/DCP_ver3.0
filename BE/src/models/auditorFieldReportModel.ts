import crypto from 'crypto';
import mongoose, { type ClientSession, Schema } from 'mongoose';

export interface AuditorFieldReportPhoto {
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

export interface AuditorFieldReportRecord {
  reportId: string;
  projectId: string;
  auditorUserId: string;
  note: string;
  verifiedMilestoneIndexes: number[];
  photos: AuditorFieldReportPhoto[];
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const gpsSchema = new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 }, longitude: { type: Number, required: true, min: -180, max: 180 } }, { _id: false });
const photoSchema = new Schema<AuditorFieldReportPhoto>({
  cid: { type: String, required: true }, contentSha256: { type: String, required: true }, fileName: { type: String, required: true }, mimeType: { type: String, enum: ['image/jpeg'], required: true },
  gps: { type: gpsSchema, required: true }, accuracyMeters: { type: Number, required: true, min: 0 }, isLowAccuracyOverride: { type: Boolean, required: true },
  overrideUnlockedAfterMs: { type: Number, default: null }, lowAccuracyReason: { type: String, default: null }, capturedAt: { type: Date, required: true },
  capturedAtClient: { type: Date, required: true }, geolocationTimestamp: { type: String, required: true }, clockSkewSeconds: { type: Number, required: true }
}, { _id: false, strict: 'throw' });
const auditorFieldReportSchema = new Schema<AuditorFieldReportRecord>({
  reportId: { type: String, required: true, unique: true }, projectId: { type: String, required: true, unique: true }, auditorUserId: { type: String, required: true },
  note: { type: String, required: true }, verifiedMilestoneIndexes: { type: [Number], required: true }, photos: { type: [photoSchema], required: true },
  submittedAt: { type: Date, required: true }, createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true }
}, { collection: 'auditor_field_reports', strict: 'throw' });

auditorFieldReportSchema.index({ auditorUserId: 1 });

export const AuditorFieldReportMongoModel = mongoose.models?.AuditorFieldReport
  || mongoose.model<AuditorFieldReportRecord>('AuditorFieldReport', auditorFieldReportSchema);

/** Tạo biên bản độc lập và khóa ở mức database mỗi dự án đúng một lần. */
export async function createAuditorFieldReport(
  payload: Omit<AuditorFieldReportRecord, 'reportId' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<AuditorFieldReportRecord> {
  const now = new Date();
  const created = await AuditorFieldReportMongoModel.create([{
    ...payload, reportId: crypto.randomUUID(), createdAt: now, updatedAt: now
  }], session ? { session } : undefined);
  return created[0].toObject() as AuditorFieldReportRecord;
}

/** Tìm biên bản duy nhất của dự án. */
export async function findAuditorFieldReportByProjectId(projectId: string): Promise<AuditorFieldReportRecord | null> {
  return AuditorFieldReportMongoModel.findOne({ projectId }).lean<AuditorFieldReportRecord>().exec();
}

/** Lấy batch biên bản theo projectId để portal Auditor không phát sinh N+1 query. */
export async function findAuditorFieldReportsByProjectIds(projectIds: string[], limitPerProject: number = 50): Promise<AuditorFieldReportRecord[]> {
  const normalizedProjectIds = [...new Set(projectIds.map(projectId => String(projectId || '').trim()).filter(Boolean))];
  if (!normalizedProjectIds.length) return [];
  const normalizedLimit = Number.isFinite(limitPerProject) ? Math.max(1, Math.min(50, Math.floor(limitPerProject))) : 50;
  return AuditorFieldReportMongoModel.aggregate<AuditorFieldReportRecord>([
    { $match: { projectId: { $in: normalizedProjectIds } } },
    { $sort: { projectId: 1, submittedAt: -1, reportId: -1 } },
    { $group: { _id: '$projectId', items: { $push: '$$ROOT' } } },
    { $project: { items: { $slice: ['$items', normalizedLimit] } } },
    { $unwind: '$items' },
    { $replaceRoot: { newRoot: '$items' } }
  ]).exec();
}

/** Liệt kê biên bản của chính auditor cho màn hình lịch sử, luôn có trần bản ghi. */
export async function findAuditorFieldReportsByAuditorUserId(auditorUserId: string, limitCount: number): Promise<AuditorFieldReportRecord[]> {
  return AuditorFieldReportMongoModel.find({ auditorUserId })
    .sort({ submittedAt: -1 })
    .limit(limitCount)
    .lean<AuditorFieldReportRecord[]>()
    .exec();
}

/**
 * Lấy toàn bộ biên bản của một auditor, không giới hạn.
 * Khác hàm lịch sử ở trên: xét điều kiện thoát vai trò phải nhìn đủ mọi ràng buộc, một trần bản ghi
 * sẽ âm thầm bỏ sót dự án đang mở và cho auditor rút hết cọc sai.
 */
export async function findAllAuditorFieldReportsByAuditorUserId(auditorUserId: string): Promise<AuditorFieldReportRecord[]> {
  return AuditorFieldReportMongoModel.find({ auditorUserId }).lean<AuditorFieldReportRecord[]>().exec();
}
