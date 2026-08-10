import mongoose, { Schema } from 'mongoose';
import type { SbtTokenStatusName } from '../constants/sbtTokenStatus';

export interface SbtStatusProjectionScope {
  chainId: string;
  contractAddress: string;
}

export interface SbtStatusProjectionCheckpointRecord extends SbtStatusProjectionScope {
  lastProcessedBlock: number;
  lastProcessedLogIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SbtStatusProjectionEventRecord extends SbtStatusProjectionScope {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  tokenId: number;
  newStatus: SbtTokenStatusName;
  reason: string;
  projectionStatus: 'PENDING' | 'APPLIED';
  retryAttempt: number;
  nextRetryAt: Date | null;
  lastAttemptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const sbtStatusProjectionCheckpointSchema = new Schema<SbtStatusProjectionCheckpointRecord>(
  {
    chainId: { type: String, required: true },
    contractAddress: { type: String, required: true },
    lastProcessedBlock: { type: Number, required: true, min: 0 },
    lastProcessedLogIndex: { type: Number, required: true, min: -1 }
  },
  { timestamps: true }
);
sbtStatusProjectionCheckpointSchema.index({ chainId: 1, contractAddress: 1 }, { unique: true });

const sbtStatusProjectionEventSchema = new Schema<SbtStatusProjectionEventRecord>(
  {
    chainId: { type: String, required: true },
    contractAddress: { type: String, required: true },
    transactionHash: { type: String, required: true },
    logIndex: { type: Number, required: true, min: 0 },
    blockNumber: { type: Number, required: true, min: 0 },
    blockHash: { type: String, required: true },
    tokenId: { type: Number, required: true, min: 0 },
    newStatus: { type: String, required: true },
    reason: { type: String, required: true, default: '' },
    projectionStatus: { type: String, required: true, enum: ['PENDING', 'APPLIED'], default: 'PENDING' },
    retryAttempt: { type: Number, required: true, min: 0, default: 0 },
    nextRetryAt: { type: Date, default: Date.now },
    lastAttemptedAt: { type: Date, default: null }
  },
  { timestamps: true }
);
sbtStatusProjectionEventSchema.index({ chainId: 1, transactionHash: 1, logIndex: 1 }, { unique: true });
// Cho worker quét bounded các event đến hạn retry mà không chặn event mới theo checkpoint log.
sbtStatusProjectionEventSchema.index({
  chainId: 1,
  contractAddress: 1,
  projectionStatus: 1,
  nextRetryAt: 1,
  blockNumber: 1,
  logIndex: 1
});

const SbtStatusProjectionCheckpointMongoModel = mongoose.model<SbtStatusProjectionCheckpointRecord>(
  'SbtStatusProjectionCheckpoint',
  sbtStatusProjectionCheckpointSchema,
  'sbt_status_projection_checkpoints'
);
const SbtStatusProjectionEventMongoModel = mongoose.model<SbtStatusProjectionEventRecord>(
  'SbtStatusProjectionEvent',
  sbtStatusProjectionEventSchema,
  'sbt_status_projection_events'
);

/** Nhận diện duplicate-key Mongo để hai worker cùng replay một log vẫn hội tụ về một event durable. */
function isMongoDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 11_000;
}

/** Đọc checkpoint durable để worker replay an toàn sau restart hoặc lần xử lý thất bại. */
export async function findSbtStatusProjectionCheckpoint(
  scope: SbtStatusProjectionScope
): Promise<SbtStatusProjectionCheckpointRecord | null> {
  return SbtStatusProjectionCheckpointMongoModel.findOne(scope).lean().exec();
}

/** Lấy toàn bộ checkpoint để phục vụ backfill một lần sau khi sửa logic bootstrap projector. */
export async function findAllSbtStatusProjectionCheckpoints(): Promise<SbtStatusProjectionCheckpointRecord[]> {
  return SbtStatusProjectionCheckpointMongoModel.find({})
    .sort({ chainId: 1, contractAddress: 1 })
    .lean()
    .exec();
}

/** Hạ checkpoint về vị trí an toàn để replay lại các status event lịch sử bị bỏ qua. */
export async function rewindSbtStatusProjectionCheckpoint(
  scope: SbtStatusProjectionScope,
  lastProcessedBlock: number,
  lastProcessedLogIndex: number
): Promise<SbtStatusProjectionCheckpointRecord | null> {
  return SbtStatusProjectionCheckpointMongoModel.findOneAndUpdate(
    scope,
    { $set: { lastProcessedBlock, lastProcessedLogIndex } },
    { returnDocument: 'after' }
  )
    .lean()
    .exec();
}

/** Ghi checkpoint sau khi toàn bộ log trong chunk đã được project thành công. */
export async function saveSbtStatusProjectionCheckpoint(
  scope: SbtStatusProjectionScope,
  lastProcessedBlock: number,
  lastProcessedLogIndex: number
): Promise<SbtStatusProjectionCheckpointRecord> {
  const checkpoint = await SbtStatusProjectionCheckpointMongoModel.findOneAndUpdate(
    {
      ...scope,
      $or: [
        { lastProcessedBlock: { $lt: lastProcessedBlock } },
        { lastProcessedBlock, lastProcessedLogIndex: { $lt: lastProcessedLogIndex } }
      ]
    },
    {
      $set: { lastProcessedBlock, lastProcessedLogIndex }
    },
    { returnDocument: 'after' }
  )
    .lean()
    .exec();
  if (checkpoint) return checkpoint as SbtStatusProjectionCheckpointRecord;

  const existingCheckpoint = await findSbtStatusProjectionCheckpoint(scope);
  if (existingCheckpoint) return existingCheckpoint;

  try {
    const createdCheckpoint = await SbtStatusProjectionCheckpointMongoModel.findOneAndUpdate(
      scope,
      { $setOnInsert: { lastProcessedBlock, lastProcessedLogIndex } },
      { upsert: true, returnDocument: 'after' }
    )
      .lean()
      .exec();
    return createdCheckpoint as SbtStatusProjectionCheckpointRecord;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;

    const concurrentCheckpoint = await findSbtStatusProjectionCheckpoint(scope);
    if (concurrentCheckpoint) return concurrentCheckpoint;
    throw error;
  }
}

/** Tạo hoặc đọc event durable theo danh tính chain/tx/log để replay luôn idempotent. */
export async function findOrCreateSbtStatusProjectionEvent(
  event: Omit<
    SbtStatusProjectionEventRecord,
    'projectionStatus' | 'retryAttempt' | 'nextRetryAt' | 'lastAttemptedAt' | 'createdAt' | 'updatedAt'
  >
): Promise<SbtStatusProjectionEventRecord> {
  const identity = {
    chainId: event.chainId,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex
  };
  try {
    const record = await SbtStatusProjectionEventMongoModel.findOneAndUpdate(
      identity,
      {
        $setOnInsert: {
          ...event,
          projectionStatus: 'PENDING',
          retryAttempt: 0,
          nextRetryAt: new Date(),
          lastAttemptedAt: null
        }
      },
      { upsert: true, returnDocument: 'after' }
    )
      .lean()
      .exec();
    return record as SbtStatusProjectionEventRecord;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;

    const concurrentRecord = await SbtStatusProjectionEventMongoModel.findOne(identity).lean().exec();
    if (concurrentRecord) return concurrentRecord;
    throw error;
  }
}

/** Lấy batch event PENDING đã đến hạn để retry công bằng và độc lập với checkpoint log. */
export async function findPendingSbtStatusProjectionEvents(
  scope: SbtStatusProjectionScope,
  limit: number,
  now = new Date()
): Promise<SbtStatusProjectionEventRecord[]> {
  return SbtStatusProjectionEventMongoModel.find({
    ...scope,
    projectionStatus: 'PENDING',
    $or: [
      { nextRetryAt: null },
      { nextRetryAt: { $lte: now } }
    ]
  })
    .sort({ nextRetryAt: 1, blockNumber: 1, logIndex: 1 })
    .limit(limit)
    .lean()
    .exec();
}

const SBT_STATUS_PROJECTION_RETRY_BASE_DELAY_MS = 15_000;
const SBT_STATUS_PROJECTION_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;
const SBT_STATUS_PROJECTION_RETRY_MAX_EXPONENT = 8;

/** Tính retry delay exponential có trần để event legacy không tạo tải Mongo liên tục nhưng vẫn được replay. */
function calculateSbtStatusProjectionRetryDelay(retryAttempt: number): number {
  const exponent = Math.min(Math.max(retryAttempt - 1, 0), SBT_STATUS_PROJECTION_RETRY_MAX_EXPONENT);
  return Math.min(
    SBT_STATUS_PROJECTION_RETRY_BASE_DELAY_MS * (2 ** exponent),
    SBT_STATUS_PROJECTION_RETRY_MAX_DELAY_MS
  );
}

/** Chuẩn hóa số lần retry của event cũ chưa có trường retryAttempt trước khi rollout backoff. */
function normalizeSbtStatusProjectionRetryAttempt(retryAttempt: unknown): number {
  return typeof retryAttempt === 'number' && Number.isSafeInteger(retryAttempt) && retryAttempt >= 0
    ? retryAttempt
    : 0;
}

/** Hoãn retry một event chưa có metadata bằng backoff durable để batch cũ không starvation event mới. */
export async function scheduleSbtStatusProjectionEventRetry(
  event: Pick<SbtStatusProjectionEventRecord, 'chainId' | 'transactionHash' | 'logIndex' | 'retryAttempt'>,
  attemptedAt = new Date()
): Promise<void> {
  const retryAttempt = normalizeSbtStatusProjectionRetryAttempt(event.retryAttempt) + 1;
  const nextRetryAt = new Date(
    attemptedAt.getTime() + calculateSbtStatusProjectionRetryDelay(retryAttempt)
  );

  await SbtStatusProjectionEventMongoModel.updateOne(
    {
      chainId: event.chainId,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      projectionStatus: 'PENDING'
    },
    {
      $inc: { retryAttempt: 1 },
      $set: { lastAttemptedAt: attemptedAt, nextRetryAt }
    }
  ).exec();
}

/** Đánh dấu event đã áp vào read model chỉ sau khi Mongo metadata cập nhật thành công hoặc event đã stale. */
export async function markSbtStatusProjectionEventApplied(
  event: Pick<SbtStatusProjectionEventRecord, 'chainId' | 'transactionHash' | 'logIndex'>
): Promise<void> {
  await SbtStatusProjectionEventMongoModel.updateOne(
    {
      chainId: event.chainId,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex
    },
    { $set: { projectionStatus: 'APPLIED', nextRetryAt: null } }
  ).exec();
}
