import mongoose, { Schema } from 'mongoose';

export const TECHNICAL_SIGNER_LOCK_NAME = 'disbursement-service-signers';

export interface TechnicalSignerExecutionLock {
  lockName: string;
  leaseId: string | null;
  fencingToken: number;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const technicalSignerExecutionLockSchema = new Schema<TechnicalSignerExecutionLock>({
  lockName: { type: String, required: true, unique: true },
  leaseId: { type: String, default: null },
  fencingToken: { type: Number, required: true, default: 0 },
  leaseExpiresAt: { type: Date, default: null }
}, { collection: 'technical_signer_execution_locks', timestamps: true });

const TechnicalSignerExecutionLockMongoModel = mongoose.models?.TechnicalSignerExecutionLock
  || mongoose.model<TechnicalSignerExecutionLock>('TechnicalSignerExecutionLock', technicalSignerExecutionLockSchema);

/**
 * Nhận khóa phân tán duy nhất cho ba signer kỹ thuật để nhiều instance worker
 * không thể đồng thời phát giao dịch bằng cùng private key.
 */
export async function claimTechnicalSignerExecutionLock(
  leaseId: string,
  leaseExpiresAt: Date,
  lockName: string = TECHNICAL_SIGNER_LOCK_NAME
): Promise<TechnicalSignerExecutionLock | null> {
  const now = new Date();
  try {
    return await TechnicalSignerExecutionLockMongoModel.findOneAndUpdate(
      {
        lockName,
        $or: [
          { leaseId },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lte: now } }
        ]
      },
      {
        $set: { leaseId, leaseExpiresAt, updatedAt: now },
        $inc: { fencingToken: 1 }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean<TechnicalSignerExecutionLock>().exec();
  } catch (error) {
    // Hai instance cùng tạo singleton lần đầu có thể va unique index; instance thua không có lock.
    if ((error as { code?: number }).code === 11000) return null;
    throw error;
  }
}

/** Gia hạn lock bằng fencing token để holder cũ không thể hồi sinh lease đã mất. */
export async function renewTechnicalSignerExecutionLock(
  leaseId: string,
  fencingToken: number,
  leaseExpiresAt: Date,
  lockName: string = TECHNICAL_SIGNER_LOCK_NAME
): Promise<boolean> {
  const now = new Date();
  const result = await TechnicalSignerExecutionLockMongoModel.updateOne(
    {
      lockName,
      leaseId,
      fencingToken,
      leaseExpiresAt: { $gt: now }
    },
    { $set: { leaseExpiresAt, updatedAt: now } }
  ).exec();
  return result.modifiedCount === 1;
}

/** Nhả khóa chỉ khi vẫn sở hữu đúng fencing token hiện tại. */
export async function releaseTechnicalSignerExecutionLock(
  leaseId: string,
  fencingToken: number,
  lockName: string = TECHNICAL_SIGNER_LOCK_NAME
): Promise<void> {
  await TechnicalSignerExecutionLockMongoModel.updateOne(
    { lockName, leaseId, fencingToken },
    { $set: { leaseId: null, leaseExpiresAt: null, updatedAt: new Date() } }
  ).exec();
}
