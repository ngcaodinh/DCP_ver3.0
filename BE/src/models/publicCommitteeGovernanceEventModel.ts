import mongoose, { Schema } from 'mongoose';

export type PublicCommitteeGovernanceEventType = 'SEATS_BOOTSTRAPPED' | 'SEAT_CHANGE_PROPOSED' | 'SEAT_CHANGE_EXECUTED' | 'DECISION_RECORDED';

export interface PublicCommitteeGovernanceEventRecord {
  chainId: string;
  contractAddress: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  occurredAt: Date;
  eventType: PublicCommitteeGovernanceEventType;
  eventData: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const publicCommitteeGovernanceEventSchema = new Schema<PublicCommitteeGovernanceEventRecord>({
  chainId: { type: String, required: true },
  contractAddress: { type: String, required: true, lowercase: true },
  transactionHash: { type: String, required: true, lowercase: true },
  blockNumber: { type: Number, required: true, min: 0 },
  logIndex: { type: Number, required: true, min: 0 },
  occurredAt: { type: Date, required: true },
  eventType: { type: String, enum: ['SEATS_BOOTSTRAPPED', 'SEAT_CHANGE_PROPOSED', 'SEAT_CHANGE_EXECUTED', 'DECISION_RECORDED'], required: true },
  eventData: { type: Schema.Types.Mixed, required: true }
}, { collection: 'public_committee_governance_events', timestamps: true });
publicCommitteeGovernanceEventSchema.index({ chainId: 1, contractAddress: 1, transactionHash: 1, logIndex: 1 }, { unique: true });
publicCommitteeGovernanceEventSchema.index({ chainId: 1, contractAddress: 1, blockNumber: -1, logIndex: -1 });

export const PublicCommitteeGovernanceEventMongoModel = mongoose.models?.PublicCommitteeGovernanceEvent
  || mongoose.model<PublicCommitteeGovernanceEventRecord>('PublicCommitteeGovernanceEvent', publicCommitteeGovernanceEventSchema);

/** Upsert event theo tọa độ chain để projector replay nhiều lần vẫn không tạo bản ghi công khai trùng lặp. */
export async function upsertPublicCommitteeGovernanceEvent(
  event: Omit<PublicCommitteeGovernanceEventRecord, 'createdAt' | 'updatedAt'>
): Promise<void> {
  await PublicCommitteeGovernanceEventMongoModel.updateOne(
    {
      chainId: event.chainId,
      contractAddress: event.contractAddress,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex
    },
    { $set: event },
    { upsert: true, setDefaultsOnInsert: true }
  ).exec();
}

/** Lấy một trang event công khai theo cursor block/log để giao diện không phải quét blockchain từ deployment block. */
export async function findPublicCommitteeGovernanceEvents(
  contractAddress: string,
  cursor: { blockNumber: number; logIndex: number } | null,
  limitCount: number
): Promise<{ items: PublicCommitteeGovernanceEventRecord[]; nextCursor: { blockNumber: number; logIndex: number } | null }> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(50, Math.floor(limitCount))) : 20;
  const events = await PublicCommitteeGovernanceEventMongoModel.find({
    contractAddress: contractAddress.toLowerCase(),
    ...(cursor ? {
      $or: [
        { blockNumber: { $lt: cursor.blockNumber } },
        { blockNumber: cursor.blockNumber, logIndex: { $lt: cursor.logIndex } }
      ]
    } : {})
  })
    .sort({ blockNumber: -1, logIndex: -1 })
    .limit(normalizedLimit + 1)
    .lean<PublicCommitteeGovernanceEventRecord[]>()
    .exec();
  const items = events.slice(0, normalizedLimit);
  const lastItem = items[items.length - 1];
  return {
    items,
    nextCursor: events.length > normalizedLimit && lastItem
      ? { blockNumber: lastItem.blockNumber, logIndex: lastItem.logIndex }
      : null
  };
}
