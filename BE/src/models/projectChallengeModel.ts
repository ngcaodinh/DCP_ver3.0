import crypto from 'crypto';
import mongoose, { type ClientSession, Schema } from 'mongoose';

export interface ProjectChallengeEvidencePhoto {
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

export interface ProjectChallengeRecord {
  challengeId: string;
  projectId: string;
  round: number;
  challengerUserId: string;
  challengerRoleAtSubmit: string;
  reason: string;
  evidencePhotos: ProjectChallengeEvidencePhoto[];
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const gpsSchema = new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 }, longitude: { type: Number, required: true, min: -180, max: 180 } }, { _id: false });
const evidencePhotoSchema = new Schema<ProjectChallengeEvidencePhoto>({
  cid: { type: String, required: true }, contentSha256: { type: String, required: true }, fileName: { type: String, required: true }, mimeType: { type: String, enum: ['image/jpeg'], required: true },
  gps: { type: gpsSchema, required: true }, accuracyMeters: { type: Number, required: true, min: 0 }, isLowAccuracyOverride: { type: Boolean, required: true },
  overrideUnlockedAfterMs: { type: Number, default: null }, lowAccuracyReason: { type: String, default: null }, capturedAt: { type: Date, required: true },
  capturedAtClient: { type: Date, required: true }, geolocationTimestamp: { type: String, required: true }, clockSkewSeconds: { type: Number, required: true }
}, { _id: false, strict: 'throw' });
const projectChallengeSchema = new Schema<ProjectChallengeRecord>({
  challengeId: { type: String, required: true, unique: true }, projectId: { type: String, required: true }, round: { type: Number, required: true, min: 1 },
  challengerUserId: { type: String, required: true }, challengerRoleAtSubmit: { type: String, required: true }, reason: { type: String, required: true },
  evidencePhotos: { type: [evidencePhotoSchema], default: [] }, submittedAt: { type: Date, required: true }, createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true }
}, { collection: 'project_challenges', strict: 'throw' });

projectChallengeSchema.index({ projectId: 1, round: 1, challengerUserId: 1 }, { unique: true });
projectChallengeSchema.index({ projectId: 1, submittedAt: -1 });
projectChallengeSchema.index({ challengerUserId: 1, submittedAt: -1 });

export const ProjectChallengeMongoModel = mongoose.models?.ProjectChallenge || mongoose.model<ProjectChallengeRecord>('ProjectChallenge', projectChallengeSchema);

/** Tạo khiếu nại với định danh ngẫu nhiên để truy vết độc lập với Mongo ObjectId. */
export async function createProjectChallenge(payload: Omit<ProjectChallengeRecord, 'challengeId' | 'createdAt' | 'updatedAt'>, session?: ClientSession): Promise<ProjectChallengeRecord> {
  const now = new Date();
  const created = await ProjectChallengeMongoModel.create([{
    ...payload, challengeId: crypto.randomUUID(), createdAt: now, updatedAt: now
  }], session ? { session } : undefined);
  return created[0].toObject() as ProjectChallengeRecord;
}

/** Lấy các khiếu nại của một vòng niêm yết theo thứ tự mới nhất. */
export async function findProjectChallenges(projectId: string, round: number): Promise<ProjectChallengeRecord[]> {
  return ProjectChallengeMongoModel.find({ projectId, round }).sort({ submittedAt: -1 }).lean<ProjectChallengeRecord[]>().exec();
}

/** Kiểm tra auditor đã khiếu nại trong vòng niêm yết hiện tại hay chưa. */
export async function hasProjectChallengeByUser(projectId: string, round: number, userId: string): Promise<boolean> {
  return Boolean(await ProjectChallengeMongoModel.exists({ projectId, round, challengerUserId: userId }));
}

/** Lấy các khiếu nại của một Auditor theo batch dự án để portal không gọi N+1 exists query. */
export async function findProjectChallengesByUserForProjectIds(userId: string, projectIds: string[]): Promise<Array<Pick<ProjectChallengeRecord, 'projectId' | 'round'>>> {
  if (!projectIds.length) return [];
  return ProjectChallengeMongoModel.find({ challengerUserId: userId, projectId: { $in: [...new Set(projectIds)] } }).select({ projectId: 1, round: 1, _id: 0 }).lean<Array<Pick<ProjectChallengeRecord, 'projectId' | 'round'>>>().exec();
}

/** Đếm khiếu nại theo dự án và vòng trong một query cho bảng niêm yết công khai. */
export async function countProjectChallengesByProjectRound(projectIds: string[]): Promise<Array<{ projectId: string; round: number; count: number }>> {
  if (!projectIds.length) return [];
  const rows = await ProjectChallengeMongoModel.aggregate<{ _id: { projectId: string; round: number }; count: number }>([
    { $match: { projectId: { $in: [...new Set(projectIds)] } } },
    { $group: { _id: { projectId: '$projectId', round: '$round' }, count: { $sum: 1 } } }
  ]).exec();
  return rows.map(row => ({ projectId: row._id.projectId, round: row._id.round, count: row.count }));
}

/** Đếm khiếu nại của một auditor từ đầu ngày UTC để áp dụng hạn mức nghiệp vụ hằng ngày. */
export async function countProjectChallengesByUserSince(userId: string, from: Date): Promise<number> {
  return ProjectChallengeMongoModel.countDocuments({ challengerUserId: userId, submittedAt: { $gte: from } }).exec();
}

/** Liệt kê khiếu nại của chính auditor kèm ảnh minh chứng, dùng index { challengerUserId, submittedAt }. */
export async function findProjectChallengesByChallengerUserId(userId: string, limitCount: number): Promise<ProjectChallengeRecord[]> {
  return ProjectChallengeMongoModel.find({ challengerUserId: userId })
    .sort({ submittedAt: -1 })
    .limit(limitCount)
    .lean<ProjectChallengeRecord[]>()
    .exec();
}
