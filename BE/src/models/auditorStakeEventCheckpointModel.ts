import mongoose, { Schema } from 'mongoose';

export interface AuditorStakeEventCheckpointScope {
  chainId: string;
  contractAddress: string;
}

export interface AuditorStakeEventCheckpoint extends AuditorStakeEventCheckpointScope {
  lastProcessedBlock: number;
  lastProcessedLogIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

const auditorStakeEventCheckpointSchema = new Schema<AuditorStakeEventCheckpoint>({
  chainId: { type: String, required: true },
  contractAddress: { type: String, required: true },
  lastProcessedBlock: { type: Number, required: true, min: 0 },
  lastProcessedLogIndex: { type: Number, required: true, min: -1 }
}, { timestamps: true });
auditorStakeEventCheckpointSchema.index({ chainId: 1, contractAddress: 1 }, { unique: true });

const AuditorStakeEventCheckpointModel = mongoose.models?.AuditorStakeEventCheckpoint
  || mongoose.model<AuditorStakeEventCheckpoint>('AuditorStakeEventCheckpoint', auditorStakeEventCheckpointSchema);

/** Nhận diện duplicate key khi hai worker cùng khởi tạo checkpoint lần đầu. */
function isMongoDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11_000;
}

/** Đọc checkpoint durable để worker restart không bỏ sót event AuditorStaking. */
export async function findAuditorStakeEventCheckpoint(
  scope: AuditorStakeEventCheckpointScope
): Promise<AuditorStakeEventCheckpoint | null> {
  return AuditorStakeEventCheckpointModel.findOne(scope).lean<AuditorStakeEventCheckpoint>().exec();
}

/** Chỉ tiến checkpoint về phía trước để một worker chậm không thể kéo lùi tiến độ worker khác. */
export async function saveAuditorStakeEventCheckpoint(
  scope: AuditorStakeEventCheckpointScope,
  lastProcessedBlock: number,
  lastProcessedLogIndex: number
): Promise<AuditorStakeEventCheckpoint> {
  const updated = await AuditorStakeEventCheckpointModel.findOneAndUpdate(
    {
      ...scope,
      $or: [
        { lastProcessedBlock: { $lt: lastProcessedBlock } },
        { lastProcessedBlock, lastProcessedLogIndex: { $lt: lastProcessedLogIndex } }
      ]
    },
    { $set: { lastProcessedBlock, lastProcessedLogIndex } },
    { returnDocument: 'after' }
  ).lean<AuditorStakeEventCheckpoint>().exec();
  if (updated) return updated;

  const existing = await findAuditorStakeEventCheckpoint(scope);
  if (existing) return existing;

  try {
    const created = await AuditorStakeEventCheckpointModel.findOneAndUpdate(
      scope,
      { $setOnInsert: { lastProcessedBlock, lastProcessedLogIndex } },
      { upsert: true, returnDocument: 'after' }
    ).lean<AuditorStakeEventCheckpoint>().exec();
    return created as AuditorStakeEventCheckpoint;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const concurrent = await findAuditorStakeEventCheckpoint(scope);
    if (concurrent) return concurrent;
    throw error;
  }
}
