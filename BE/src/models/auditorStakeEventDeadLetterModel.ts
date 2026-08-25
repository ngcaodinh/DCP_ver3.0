import mongoose, { Schema } from 'mongoose';
import type { AuditorStakeEventCheckpointScope } from './auditorStakeEventCheckpointModel';

export interface AuditorStakeEventDeadLetter extends AuditorStakeEventCheckpointScope {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  failureCount: number;
  lastError: string;
  firstFailedAt: Date;
  lastFailedAt: Date;
  deadLetteredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const auditorStakeEventDeadLetterSchema = new Schema<AuditorStakeEventDeadLetter>({
  chainId: { type: String, required: true },
  contractAddress: { type: String, required: true },
  transactionHash: { type: String, required: true },
  logIndex: { type: Number, required: true, min: 0 },
  blockNumber: { type: Number, required: true, min: 0 },
  failureCount: { type: Number, required: true, min: 1 },
  lastError: { type: String, required: true },
  firstFailedAt: { type: Date, required: true },
  lastFailedAt: { type: Date, required: true },
  deadLetteredAt: { type: Date, default: null }
}, { timestamps: true });

auditorStakeEventDeadLetterSchema.index(
  { chainId: 1, contractAddress: 1, transactionHash: 1, logIndex: 1 },
  { unique: true }
);

const AuditorStakeEventDeadLetterModel = mongoose.models?.AuditorStakeEventDeadLetter
  || mongoose.model<AuditorStakeEventDeadLetter>('AuditorStakeEventDeadLetter', auditorStakeEventDeadLetterSchema);

/** Ghi nhận một lần project thất bại để số retry liên tiếp còn đúng sau process restart. */
export async function recordAuditorStakeEventProjectionFailure(input: {
  scope: AuditorStakeEventCheckpointScope;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  errorMessage: string;
}): Promise<AuditorStakeEventDeadLetter> {
  const now = new Date();
  const updated = await AuditorStakeEventDeadLetterModel.findOneAndUpdate(
    {
      ...input.scope,
      transactionHash: input.transactionHash,
      logIndex: input.logIndex
    },
    {
      $inc: { failureCount: 1 },
      $set: {
        blockNumber: input.blockNumber,
        lastError: input.errorMessage,
        lastFailedAt: now
      },
      $setOnInsert: {
        ...input.scope,
        transactionHash: input.transactionHash,
        logIndex: input.logIndex,
        firstFailedAt: now,
        deadLetteredAt: null
      }
    },
    { upsert: true, returnDocument: 'after' }
  ).exec();
  return updated!.toObject() as AuditorStakeEventDeadLetter;
}

/** Đánh dấu event không thể project để vận hành xử lý riêng mà checkpoint vẫn được tiếp tục. */
export async function markAuditorStakeEventAsDeadLetter(input: {
  scope: AuditorStakeEventCheckpointScope;
  transactionHash: string;
  logIndex: number;
  minimumFailureCount: number;
}): Promise<void> {
  await AuditorStakeEventDeadLetterModel.updateOne(
    {
      ...input.scope,
      transactionHash: input.transactionHash,
      logIndex: input.logIndex,
      failureCount: { $gte: input.minimumFailureCount },
      deadLetteredAt: null
    },
    { $set: { deadLetteredAt: new Date() } }
  ).exec();
}

/** Xóa bộ đếm sau khi event project thành công để lần lỗi sau bắt đầu một chuỗi retry mới. */
export async function clearAuditorStakeEventProjectionFailure(input: {
  scope: AuditorStakeEventCheckpointScope;
  transactionHash: string;
  logIndex: number;
}): Promise<void> {
  await AuditorStakeEventDeadLetterModel.deleteOne({
    ...input.scope,
    transactionHash: input.transactionHash,
    logIndex: input.logIndex
  }).exec();
}
