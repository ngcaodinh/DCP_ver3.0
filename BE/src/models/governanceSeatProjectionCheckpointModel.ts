import mongoose, { Schema } from 'mongoose';

export interface GovernanceSeatProjectionCheckpoint {
  chainId: string;
  contractAddress: string;
  lastProcessedBlock: number;
  lastProcessedLogIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

const governanceSeatProjectionCheckpointSchema = new Schema<GovernanceSeatProjectionCheckpoint>({
  chainId: { type: String, required: true },
  contractAddress: { type: String, required: true, lowercase: true },
  lastProcessedBlock: { type: Number, required: true, min: 0 },
  lastProcessedLogIndex: { type: Number, required: true, min: -1 }
}, { collection: 'governance_seat_projection_checkpoints', timestamps: true });
governanceSeatProjectionCheckpointSchema.index({ chainId: 1, contractAddress: 1 }, { unique: true });

const GovernanceSeatProjectionCheckpointMongoModel = mongoose.models?.GovernanceSeatProjectionCheckpoint
  || mongoose.model<GovernanceSeatProjectionCheckpoint>('GovernanceSeatProjectionCheckpoint', governanceSeatProjectionCheckpointSchema);

export async function findGovernanceSeatProjectionCheckpoint(
  scope: Pick<GovernanceSeatProjectionCheckpoint, 'chainId' | 'contractAddress'>
): Promise<GovernanceSeatProjectionCheckpoint | null> {
  return GovernanceSeatProjectionCheckpointMongoModel.findOne(scope).lean<GovernanceSeatProjectionCheckpoint>().exec();
}

/** Checkpoint chỉ tiến để nhiều instance có replay idempotent nhưng không thể làm lùi event cursor. */
export async function saveGovernanceSeatProjectionCheckpoint(
  scope: Pick<GovernanceSeatProjectionCheckpoint, 'chainId' | 'contractAddress'>,
  lastProcessedBlock: number,
  lastProcessedLogIndex: number
): Promise<GovernanceSeatProjectionCheckpoint> {
  try {
    const updated = await GovernanceSeatProjectionCheckpointMongoModel.findOneAndUpdate(
      {
        ...scope,
        $or: [
          { lastProcessedBlock: { $lt: lastProcessedBlock } },
          { lastProcessedBlock, lastProcessedLogIndex: { $lt: lastProcessedLogIndex } }
        ]
      },
      { $set: { lastProcessedBlock, lastProcessedLogIndex } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean<GovernanceSeatProjectionCheckpoint>().exec();
    if (updated) return updated;
    const existing = await findGovernanceSeatProjectionCheckpoint(scope);
    if (existing) return existing;
    throw new Error('Không thể lưu checkpoint projector ghế ủy ban.');
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const concurrent = await findGovernanceSeatProjectionCheckpoint(scope);
    if (concurrent) return concurrent;
    throw error;
  }
}
