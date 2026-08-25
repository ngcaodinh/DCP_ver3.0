import mongoose, { Schema } from 'mongoose';

export type AuditorStakeIntentStatus = 'PENDING_TX' | 'VERIFYING' | 'ACTIVATED' | 'FAILED';

export type AuditorStakeIntent = {
  id: string;
  userId: string;
  walletAddress: string;
  minimumStakeThreshold: string;
  status: AuditorStakeIntentStatus;
  txHash: string | null;
  failureReason: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
};

const auditorStakeIntentSchema = new Schema<AuditorStakeIntent>({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  walletAddress: { type: String, required: true },
  minimumStakeThreshold: { type: String, required: true },
  status: { type: String, required: true },
  txHash: { type: String, default: null },
  failureReason: { type: String, default: null },
  correlationId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

auditorStakeIntentSchema.index({ userId: 1, createdAt: -1 });
auditorStakeIntentSchema.index({ status: 1, createdAt: 1 });
auditorStakeIntentSchema.index(
  { txHash: 1 },
  { unique: true, partialFilterExpression: { txHash: { $type: 'string' } } }
);

const AuditorStakeIntentModel = mongoose.models?.AuditorStakeIntent
  || mongoose.model<AuditorStakeIntent>('AuditorStakeIntent', auditorStakeIntentSchema);

/** Tạo intent đặt cọc để ghi nhận vòng đời onboarding của một Kiểm toán viên. */
export async function createAuditorStakeIntent(intent: AuditorStakeIntent): Promise<AuditorStakeIntent> {
  const createdIntent = await AuditorStakeIntentModel.create(intent);
  return createdIntent.toObject() as AuditorStakeIntent;
}

/** Tìm intent bằng định danh công khai được trả về cho người dùng. */
export async function findAuditorStakeIntentById(intentId: string): Promise<AuditorStakeIntent | null> {
  return AuditorStakeIntentModel.findOne({ id: intentId }).lean<AuditorStakeIntent>().exec();
}

/** Lấy intent mới nhất của người dùng để reconcile có thể hội tụ về trạng thái hoạt động. */
export async function findLatestAuditorStakeIntentByUserId(userId: string): Promise<AuditorStakeIntent | null> {
  return AuditorStakeIntentModel.findOne({ userId })
    .sort({ createdAt: -1 })
    .lean<AuditorStakeIntent>()
    .exec();
}

/** Lấy các intent quá hạn theo index status/createdAt để worker không quét toàn collection. */
export async function findExpiredAuditorStakeIntents(cutoff: Date): Promise<AuditorStakeIntent[]> {
  return AuditorStakeIntentModel.find({
    status: { $in: ['PENDING_TX', 'VERIFYING'] },
    createdAt: { $lt: cutoff }
  })
    .sort({ createdAt: 1 })
    .lean<AuditorStakeIntent[]>()
    .exec();
}

/** Cập nhật toàn bộ intent theo mẫu model hiện có để đồng bộ trạng thái on-chain. */
export async function updateAuditorStakeIntent(intent: AuditorStakeIntent): Promise<AuditorStakeIntent> {
  const updatedIntent = await AuditorStakeIntentModel.findOneAndUpdate(
    { id: intent.id },
    intent,
    { returnDocument: 'after' }
  ).exec();
  return (updatedIntent?.toObject() as AuditorStakeIntent) || intent;
}
