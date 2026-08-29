import mongoose, { Schema } from 'mongoose';

export interface DisbursementRequestProjectionCheckpoint {
  chainId: string;
  contractAddress: string;
  lastProcessedBlock: number;
  lastProcessedLogIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

const checkpointSchema = new Schema<DisbursementRequestProjectionCheckpoint>({
  chainId: { type: String, required: true },
  contractAddress: { type: String, required: true, lowercase: true },
  lastProcessedBlock: { type: Number, required: true, min: 0 },
  lastProcessedLogIndex: { type: Number, required: true, min: -1 }
}, { collection: 'disbursement_request_projection_checkpoints', timestamps: true });
checkpointSchema.index({ chainId: 1, contractAddress: 1 }, { unique: true });

const CheckpointMongoModel = mongoose.models?.DisbursementRequestProjectionCheckpoint
  || mongoose.model<DisbursementRequestProjectionCheckpoint>('DisbursementRequestProjectionCheckpoint', checkpointSchema);

export async function findDisbursementRequestProjectionCheckpoint(scope: Pick<DisbursementRequestProjectionCheckpoint, 'chainId' | 'contractAddress'>): Promise<DisbursementRequestProjectionCheckpoint | null> {
  return CheckpointMongoModel.findOne(scope).lean<DisbursementRequestProjectionCheckpoint>().exec();
}

/** Chỉ tiến checkpoint để mọi instance replay idempotent nhưng không thể làm lùi cursor của instance khác. */
export async function saveDisbursementRequestProjectionCheckpoint(
  scope: Pick<DisbursementRequestProjectionCheckpoint, 'chainId' | 'contractAddress'>,
  lastProcessedBlock: number,
  lastProcessedLogIndex: number
): Promise<DisbursementRequestProjectionCheckpoint> {
  try {
    const updated = await CheckpointMongoModel.findOneAndUpdate(
      {
        ...scope,
        $or: [
          { lastProcessedBlock: { $lt: lastProcessedBlock } },
          { lastProcessedBlock, lastProcessedLogIndex: { $lt: lastProcessedLogIndex } }
        ]
      },
      { $set: { lastProcessedBlock, lastProcessedLogIndex } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean<DisbursementRequestProjectionCheckpoint>().exec();
    if (updated) return updated;
    const existing = await findDisbursementRequestProjectionCheckpoint(scope);
    if (existing) return existing;
    throw new Error('Không thể lưu checkpoint projection giải ngân.');
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const concurrent = await findDisbursementRequestProjectionCheckpoint(scope);
    if (concurrent) return concurrent;
    throw error;
  }
}
