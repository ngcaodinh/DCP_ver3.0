import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';
import type { CommitteeDecisionKind, CommitteeVoteDecision } from '../services/committeeGovernanceEip712.service';

export interface CommitteeVoteSigningRequest {
  signingRequestId: string;
  kind: CommitteeDecisionKind;
  businessId: string;
  voterUserId: string;
  decision: CommitteeVoteDecision;
  reasonCommitment: string;
  committeeEpoch: string;
  nonce: string;
  deadline: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const committeeVoteSigningRequestSchema = new Schema<CommitteeVoteSigningRequest>({
  signingRequestId: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['DISBURSEMENT', 'ARBITRATION'], required: true },
  businessId: { type: String, required: true },
  voterUserId: { type: String, required: true },
  decision: { type: String, enum: ['APPROVE', 'REJECT', 'UPHOLD_PROJECT', 'REJECT_PROJECT'], required: true },
  reasonCommitment: { type: String, required: true, lowercase: true },
  committeeEpoch: { type: String, required: true },
  nonce: { type: String, required: true },
  deadline: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: { type: Date, default: null }
}, { collection: 'committee_vote_signing_requests', timestamps: true });
committeeVoteSigningRequestSchema.index({ kind: 1, businessId: 1, voterUserId: 1, consumedAt: 1, deadline: 1 });

export const CommitteeVoteSigningRequestMongoModel = mongoose.models?.CommitteeVoteSigningRequest
  || mongoose.model<CommitteeVoteSigningRequest>('CommitteeVoteSigningRequest', committeeVoteSigningRequestSchema);

/** Lưu yêu cầu ký do server phát hành để backend không tin schema hoặc nonce do trình duyệt tự tạo. */
export async function createCommitteeVoteSigningRequest(
  payload: Omit<CommitteeVoteSigningRequest, 'signingRequestId' | 'consumedAt' | 'createdAt' | 'updatedAt'>
): Promise<CommitteeVoteSigningRequest> {
  return (await CommitteeVoteSigningRequestMongoModel.create({
    ...payload,
    signingRequestId: crypto.randomUUID(),
    consumedAt: null
  })).toObject() as CommitteeVoteSigningRequest;
}

/** Đọc yêu cầu ký theo ID opaque trước khi dựng lại typed-data canonical ở server. */
export async function findCommitteeVoteSigningRequest(signingRequestId: string): Promise<CommitteeVoteSigningRequest | null> {
  return CommitteeVoteSigningRequestMongoModel.findOne({ signingRequestId }).lean<CommitteeVoteSigningRequest>().exec();
}

/** Consume bằng CAS để một signing request không thể bị replay thành nhiều vote. */
export async function consumeCommitteeVoteSigningRequest(signingRequestId: string): Promise<boolean> {
  const result = await CommitteeVoteSigningRequestMongoModel.updateOne(
    { signingRequestId, consumedAt: null, deadline: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } }
  ).exec();
  return result.modifiedCount === 1;
}
