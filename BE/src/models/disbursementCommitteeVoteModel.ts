import crypto from 'crypto';
import mongoose, { Schema, type ClientSession } from 'mongoose';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';

export type DisbursementCommitteeStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type DisbursementCommitteeDecision = 'APPROVE' | 'REJECT';
export type DisbursementCommitteeRole = typeof EXECUTIVE_CHAIR_ROLE | typeof EXECUTIVE_MEMBER_ROLE;
export type DisbursementCommitteeExecutionStatus = 'PENDING' | 'WAITING_ON_CHAIN_DECISION' | 'PROCESSING' | 'COMPLETED' | 'DEAD_LETTER';
export type OnChainDecisionStatus = 'PENDING' | 'RECORDED' | 'NEEDS_RESIGN' | 'DEAD_LETTER';

const MAXIMUM_EXECUTION_ATTEMPT_COUNT = 8;
const EXECUTION_RETRY_BASE_DELAY_MS = 30_000;
const EXECUTION_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const MAXIMUM_ON_CHAIN_DECISION_ATTEMPT_COUNT = 8;
const ON_CHAIN_DECISION_RETRY_BASE_DELAY_MS = 30_000;
const ON_CHAIN_DECISION_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;

export interface DisbursementCommitteeSnapshotMember {
  userId: string;
  role: DisbursementCommitteeRole;
  fullName: string;
  walletAddress: string;
  governanceWalletAddress: string | null;
}

export interface DisbursementCommitteeVote {
  voterUserId: string;
  voterRole: DisbursementCommitteeRole;
  decision: DisbursementCommitteeDecision;
  reason: string;
  votedAt: Date;
  /** Để sẵn cho Giai đoạn 2 khi vote được ký bằng MetaMask/EIP-712. */
  signature: string | null;
  /** Để sẵn hash payload xác minh công khai ở Giai đoạn 2. */
  signedPayloadHash: string | null;
  /** Commitment của lý do đã được nonce EIP-712 gắn vào signing request server-issued. */
  reasonCommitment?: string | null;
  /** Nonce/deadline chính xác đã ký; relayer chuyển nguyên văn vào struct contract. */
  nonce?: string | null;
  deadline?: Date | null;
  /** Epoch roster được signer xác nhận để relayer chặn chữ ký cũ trước khi broadcast. */
  committeeEpoch?: string | null;
}

export interface DisbursementCommitteeSupersededVoteRound {
  committeeSnapshot: DisbursementCommitteeSnapshotMember[];
  votes: DisbursementCommitteeVote[];
  supersededAt: Date;
  reason: string;
}

export interface DisbursementCommitteeResignContext {
  committeeSnapshot: DisbursementCommitteeSnapshotMember[];
  deadlineAt: Date;
}

export type DisbursementCommitteeRecoveryScope = 'EXECUTION' | 'ON_CHAIN_DECISION';

export interface DisbursementCommitteeVoteRecord {
  committeeVoteId: string;
  requestId: string;
  status: DisbursementCommitteeStatus;
  committeeSnapshot: DisbursementCommitteeSnapshotMember[];
  requiredMemberVotes: number;
  votes: DisbursementCommitteeVote[];
  /** Lưu round chữ ký đã bị thay thế để bằng chứng EIP-712 không bao giờ bị xóa. */
  supersededVoteRounds: DisbursementCommitteeSupersededVoteRound[];
  /** Chỉ được điền sau khi quyết định đã được ghi on-chain ở Giai đoạn 2. */
  onChainDecisionTxHash: string | null;
  onChainDecisionStatus?: OnChainDecisionStatus;
  onChainDecisionRecordedAt?: Date | null;
  onChainDecisionAttemptCount?: number;
  onChainDecisionNextAttemptAt?: Date | null;
  onChainDecisionLastError?: string | null;
  executionStatus: DisbursementCommitteeExecutionStatus;
  executionLeaseId: string | null;
  executionLeaseExpiresAt: Date | null;
  executionAttemptCount: number;
  executionNextAttemptAt: Date | null;
  executionLastError: string | null;
  openedAt: Date;
  deadlineAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const snapshotMemberSchema = new Schema<DisbursementCommitteeSnapshotMember>({
  userId: { type: String, required: true },
  role: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  fullName: { type: String, required: true },
  walletAddress: { type: String, required: true },
  governanceWalletAddress: { type: String, default: null }
}, { _id: false });

const committeeVoteSchema = new Schema<DisbursementCommitteeVote>({
  voterUserId: { type: String, required: true },
  voterRole: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  decision: { type: String, enum: ['APPROVE', 'REJECT'], required: true },
  reason: { type: String, required: true },
  votedAt: { type: Date, required: true },
  signature: { type: String, default: null },
  signedPayloadHash: { type: String, default: null },
  reasonCommitment: { type: String, default: null },
  nonce: { type: String, default: null }, committeeEpoch: { type: String, default: null },
  deadline: { type: Date, default: null }
}, { _id: false });

const supersededVoteRoundSchema = new Schema<DisbursementCommitteeSupersededVoteRound>({
  committeeSnapshot: { type: [snapshotMemberSchema], required: true },
  votes: { type: [committeeVoteSchema], required: true },
  supersededAt: { type: Date, required: true },
  reason: { type: String, required: true }
}, { _id: false });

const disbursementCommitteeVoteSchema = new Schema<DisbursementCommitteeVoteRecord>({
  committeeVoteId: { type: String, required: true, unique: true },
  requestId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], required: true, default: 'PENDING' },
  committeeSnapshot: { type: [snapshotMemberSchema], required: true, default: [] },
  requiredMemberVotes: { type: Number, required: true },
  votes: { type: [committeeVoteSchema], required: true, default: [] },
  supersededVoteRounds: { type: [supersededVoteRoundSchema], required: true, default: [] },
  onChainDecisionTxHash: { type: String, default: null },
  onChainDecisionStatus: { type: String, enum: ['PENDING', 'RECORDED', 'NEEDS_RESIGN', 'DEAD_LETTER'], required: true, default: 'PENDING' },
  onChainDecisionRecordedAt: { type: Date, default: null },
  onChainDecisionAttemptCount: { type: Number, required: true, default: 0 },
  onChainDecisionNextAttemptAt: { type: Date, default: null },
  onChainDecisionLastError: { type: String, default: null },
  executionStatus: { type: String, enum: ['PENDING', 'WAITING_ON_CHAIN_DECISION', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER'], required: true, default: 'PENDING' },
  executionLeaseId: { type: String, default: null },
  executionLeaseExpiresAt: { type: Date, default: null },
  executionAttemptCount: { type: Number, required: true, default: 0 },
  executionNextAttemptAt: { type: Date, default: null },
  executionLastError: { type: String, default: null },
  openedAt: { type: Date, required: true },
  deadlineAt: { type: Date, required: true },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
}, { collection: 'disbursement_committee_votes' });

disbursementCommitteeVoteSchema.index({ status: 1, deadlineAt: 1, committeeVoteId: 1 });
disbursementCommitteeVoteSchema.index({ status: 1, executionStatus: 1, executionNextAttemptAt: 1, resolvedAt: 1 });
disbursementCommitteeVoteSchema.index({ status: 1, onChainDecisionStatus: 1, onChainDecisionNextAttemptAt: 1, resolvedAt: 1 });
disbursementCommitteeVoteSchema.index({ 'committeeSnapshot.userId': 1, status: 1 });

export const DisbursementCommitteeVoteMongoModel = mongoose.models?.DisbursementCommitteeVote
  || mongoose.model<DisbursementCommitteeVoteRecord>('DisbursementCommitteeVote', disbursementCommitteeVoteSchema);

/** Mở sổ phiếu duy nhất cho một yêu cầu giải ngân và snapshot người được quyền tại thời điểm đó. */
export async function createDisbursementCommitteeVote(
  payload: Omit<DisbursementCommitteeVoteRecord, 'committeeVoteId' | 'votes' | 'supersededVoteRounds' | 'onChainDecisionTxHash' | 'onChainDecisionStatus' | 'onChainDecisionRecordedAt' | 'onChainDecisionAttemptCount' | 'onChainDecisionNextAttemptAt' | 'onChainDecisionLastError' | 'executionStatus' | 'executionLeaseId' | 'executionLeaseExpiresAt' | 'executionAttemptCount' | 'executionNextAttemptAt' | 'executionLastError' | 'resolvedAt' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<DisbursementCommitteeVoteRecord> {
  const now = new Date();
  const created = await DisbursementCommitteeVoteMongoModel.create([{
    ...payload,
    committeeVoteId: crypto.randomUUID(),
    votes: [],
    supersededVoteRounds: [],
    onChainDecisionTxHash: null,
    onChainDecisionStatus: 'PENDING',
    onChainDecisionRecordedAt: null,
    onChainDecisionAttemptCount: 0,
    onChainDecisionNextAttemptAt: null,
    onChainDecisionLastError: null,
    executionStatus: 'PENDING',
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    executionAttemptCount: 0,
    executionNextAttemptAt: null,
    executionLastError: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now
  }], session ? { session } : undefined);
  return created[0].toObject() as DisbursementCommitteeVoteRecord;
}

/** Lấy vote case theo requestId để vote và worker cùng dùng chung một khóa nghiệp vụ. */
export async function findDisbursementCommitteeVoteByRequestId(requestId: string): Promise<DisbursementCommitteeVoteRecord | null> {
  return DisbursementCommitteeVoteMongoModel.findOne({ requestId }).lean<DisbursementCommitteeVoteRecord>().exec();
}

/** Liệt kê case còn mở của một ủy viên, không để lộ request không thuộc snapshot. */
export async function findPendingDisbursementCommitteeVotes(
  committeeUserId?: string,
  cursor?: { deadlineAt: Date; committeeVoteId: string } | null,
  limitCount: number = 20
): Promise<{ items: DisbursementCommitteeVoteRecord[]; nextCursor: { deadlineAt: Date; committeeVoteId: string } | null }> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(50, Math.floor(limitCount))) : 20;
  const items = await DisbursementCommitteeVoteMongoModel.find({
    status: 'PENDING',
    ...(cursor ? {
      $or: [
        { deadlineAt: { $gt: cursor.deadlineAt } },
        { deadlineAt: cursor.deadlineAt, committeeVoteId: { $gt: cursor.committeeVoteId } }
      ]
    } : {}),
    ...(committeeUserId ? { 'committeeSnapshot.userId': committeeUserId } : {})
  }).sort({ deadlineAt: 1 }).limit(normalizedLimit + 1).lean<DisbursementCommitteeVoteRecord[]>().exec();
  const pageItems = items.slice(0, normalizedLimit);
  return {
    items: pageItems,
    nextCursor: items.length > normalizedLimit && pageItems.length > 0
      ? {
        deadlineAt: pageItems[pageItems.length - 1].deadlineAt,
        committeeVoteId: pageItems[pageItems.length - 1].committeeVoteId
      }
      : null
  };
}

/** Liệt kê case đã được Ủy ban phê duyệt để worker chấp hành ký bằng ba ví kỹ thuật. */
export async function findApprovedDisbursementCommitteeVotes(
  limitCount: number,
  requiresOnChainDecision: boolean = false
): Promise<DisbursementCommitteeVoteRecord[]> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(100, Math.floor(limitCount))) : 20;
  const now = new Date();
  return DisbursementCommitteeVoteMongoModel.find({
    status: 'APPROVED',
    ...(requiresOnChainDecision ? { onChainDecisionStatus: 'RECORDED' } : {}),
    $or: [
      {
        executionStatus: { $in: ['PENDING', null] },
        $or: [
          { executionNextAttemptAt: null },
          { executionNextAttemptAt: { $lte: now } }
        ]
      },
      { executionStatus: 'PROCESSING', executionLeaseExpiresAt: { $lte: now } }
    ]
  })
    .sort({ executionNextAttemptAt: 1, resolvedAt: 1 })
    .limit(normalizedLimit)
    .lean<DisbursementCommitteeVoteRecord[]>()
    .exec();
}

/** Lấy các kết quả biểu quyết đã chốt nhưng chưa có receipt DecisionRecorded để relayer xử lý tuần tự. */
export async function findResolvedDisbursementCommitteeVotesNeedingOnChainDecision(limitCount: number): Promise<DisbursementCommitteeVoteRecord[]> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(100, Math.floor(limitCount))) : 20;
  const now = new Date();
  return DisbursementCommitteeVoteMongoModel.find({
    status: { $in: ['APPROVED', 'REJECTED'] },
    onChainDecisionStatus: 'PENDING',
    $or: [
      { onChainDecisionNextAttemptAt: null },
      { onChainDecisionNextAttemptAt: { $lte: now } }
    ]
  })
    .sort({ resolvedAt: 1, committeeVoteId: 1 })
    .limit(normalizedLimit)
    .lean<DisbursementCommitteeVoteRecord[]>()
    .exec();
}

/** Ghi receipt theo compare-and-set để retry/relayer song song không thể ghi đè transaction hash đầu tiên. */
export async function markDisbursementCommitteeDecisionRecorded(
  requestId: string,
  transactionHash: string | null
): Promise<void> {
  const now = new Date();
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, status: { $in: ['APPROVED', 'REJECTED'] }, onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: 'RECORDED',
        onChainDecisionTxHash: transactionHash,
        onChainDecisionRecordedAt: now,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: null,
        executionStatus: 'PENDING',
        updatedAt: now
      }
    }
  ).exec();
}

/** Đánh dấu hồ sơ phải ký lại khi epoch hoặc deadline làm mọi chữ ký hiện tại không thể relay an toàn. */
export async function markDisbursementCommitteeDecisionNeedsResign(
  requestId: string,
  reason: string,
  resignContext: DisbursementCommitteeResignContext
): Promise<boolean> {
  const now = new Date();
  const normalizedReason = reason.slice(0, 500);
  const reopened = await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, status: 'APPROVED', onChainDecisionStatus: 'PENDING' },
    [{
      $set: {
        status: 'PENDING',
        committeeSnapshot: resignContext.committeeSnapshot,
        deadlineAt: resignContext.deadlineAt,
        // Pipeline update giữ nguyên vote/snapshot cũ trong cùng CAS trước khi mở round ký mới.
        supersededVoteRounds: {
          $concatArrays: [
            { $ifNull: ['$supersededVoteRounds', []] },
            [{
              committeeSnapshot: '$committeeSnapshot',
              votes: '$votes',
              supersededAt: now,
              reason: { $literal: normalizedReason }
            }]
          ]
        },
        votes: [],
        resolvedAt: null,
        onChainDecisionStatus: 'NEEDS_RESIGN',
        onChainDecisionAttemptCount: 0,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: normalizedReason,
        executionStatus: 'WAITING_ON_CHAIN_DECISION',
        updatedAt: now
      }
    }]
  ).exec();
  if (reopened.modifiedCount === 1) return true;
  const isolated = await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, status: 'REJECTED', onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: 'NEEDS_RESIGN',
        onChainDecisionAttemptCount: 0,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: normalizedReason,
        updatedAt: now
      }
    }
  ).exec();
  return isolated.modifiedCount === 1;
}

/** Tính backoff có jitter xác định cho lỗi relay để một hồ sơ hỏng không chiếm đầu hàng đợi mãi mãi. */
export function getDisbursementCommitteeOnChainDecisionRetryDelayMs(requestId: string, attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  const baseDelay = Math.min(ON_CHAIN_DECISION_RETRY_MAX_DELAY_MS, ON_CHAIN_DECISION_RETRY_BASE_DELAY_MS * (2 ** exponent));
  const jitterSeed = crypto.createHash('sha256').update(`on-chain-decision:${requestId}:${attemptCount}`).digest()[0] || 0;
  return baseDelay + Math.floor(baseDelay * 0.25 * (jitterSeed / 255));
}

/** Ghi lỗi relay có backoff và chuyển DLQ sau số lần thử hữu hạn để operator có thể xử lý minh bạch. */
export async function releaseDisbursementCommitteeOnChainDecision(
  requestId: string,
  attemptCount: number,
  errorMessage: string
): Promise<void> {
  const now = new Date();
  const shouldDeadLetter = attemptCount >= MAXIMUM_ON_CHAIN_DECISION_ATTEMPT_COUNT;
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, status: { $in: ['APPROVED', 'REJECTED'] }, onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: shouldDeadLetter ? 'DEAD_LETTER' : 'PENDING',
        onChainDecisionNextAttemptAt: shouldDeadLetter
          ? null
          : new Date(now.getTime() + getDisbursementCommitteeOnChainDecisionRetryDelayMs(requestId, attemptCount)),
        onChainDecisionLastError: errorMessage.slice(0, 500),
        updatedAt: now
      },
      $inc: { onChainDecisionAttemptCount: 1 }
    }
  ).exec();
}

/** Cô lập ngay quyết định không thể có đủ chữ ký để relayer không giữ đầu hàng đợi vô thời hạn. */
export async function deadLetterDisbursementCommitteeOnChainDecision(
  requestId: string,
  errorMessage: string
): Promise<void> {
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, status: { $in: ['APPROVED', 'REJECTED'] }, onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: 'DEAD_LETTER',
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: errorMessage.slice(0, 500),
        updatedAt: new Date()
      }
    }
  ).exec();
}

/** Khôi phục có chủ đích DLQ signer hoặc relayer sau khi operator đã đối soát nguyên nhân và audit log. */
export async function recoverDisbursementCommitteeExecution(
  requestId: string,
  scope: DisbursementCommitteeRecoveryScope = 'EXECUTION'
): Promise<boolean> {
  const isOnChainDecisionRecovery = scope === 'ON_CHAIN_DECISION';
  const result = await DisbursementCommitteeVoteMongoModel.updateOne(
    isOnChainDecisionRecovery
      ? {
        requestId,
        status: { $in: ['APPROVED', 'REJECTED'] },
        onChainDecisionStatus: { $in: ['DEAD_LETTER', 'NEEDS_RESIGN'] }
      }
      : { requestId, status: 'APPROVED', executionStatus: 'DEAD_LETTER' },
    {
      $set: {
        ...(isOnChainDecisionRecovery
          ? {
            onChainDecisionStatus: 'PENDING',
            onChainDecisionAttemptCount: 0,
            onChainDecisionNextAttemptAt: null,
            onChainDecisionLastError: null
          }
          : {
            executionStatus: 'PENDING',
            executionLeaseId: null,
            executionLeaseExpiresAt: null,
            executionAttemptCount: 0,
            executionNextAttemptAt: null,
            executionLastError: null
          }),
        updatedAt: new Date()
      }
    }
  ).exec();
  return result.modifiedCount === 1;
}

/** Nhận lease execution bằng CAS để chỉ một worker instance được phép ký ba ví kỹ thuật cho một case. */
export async function claimApprovedDisbursementCommitteeVote(
  requestId: string,
  leaseId: string,
  leaseExpiresAt: Date,
  requiresOnChainDecision: boolean = false
): Promise<DisbursementCommitteeVoteRecord | null> {
  const now = new Date();
  return DisbursementCommitteeVoteMongoModel.findOneAndUpdate(
    {
      requestId,
      status: 'APPROVED',
      ...(requiresOnChainDecision ? { onChainDecisionStatus: 'RECORDED' } : {}),
      $or: [
        {
          executionStatus: { $in: ['PENDING', null] },
          $or: [
            { executionNextAttemptAt: null },
            { executionNextAttemptAt: { $lte: now } }
          ]
        },
        { executionStatus: 'PROCESSING', executionLeaseExpiresAt: { $lte: now } }
      ]
    },
    {
      $set: {
        executionStatus: 'PROCESSING',
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: leaseExpiresAt,
        executionNextAttemptAt: null,
        executionLastError: null,
        updatedAt: now
      },
      $inc: { executionAttemptCount: 1 }
    },
    { returnDocument: 'after' }
  ).lean<DisbursementCommitteeVoteRecord>().exec();
}

/** Đánh dấu case đã được worker xử lý xong để queue luôn tiến tới case mới hơn. */
export async function completeDisbursementCommitteeExecution(requestId: string, leaseId: string): Promise<void> {
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, executionStatus: 'PROCESSING', executionLeaseId: leaseId },
    {
      $set: {
        executionStatus: 'COMPLETED',
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        executionNextAttemptAt: null,
        executionLastError: null,
        updatedAt: new Date()
      }
    }
  ).exec();
}

/** Tính backoff mũ có jitter xác định để case lỗi không độc chiếm đầu hàng đợi. */
export function getDisbursementCommitteeExecutionRetryDelayMs(requestId: string, attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  const baseDelay = Math.min(EXECUTION_RETRY_MAX_DELAY_MS, EXECUTION_RETRY_BASE_DELAY_MS * (2 ** exponent));
  const jitterSeed = crypto.createHash('sha256').update(`${requestId}:${attemptCount}`).digest()[0] || 0;
  const jitter = Math.floor(baseDelay * 0.25 * (jitterSeed / 255));
  return baseDelay + jitter;
}

/** Nhả lease theo backoff hoặc chuyển DLQ khi quá trần, chỉ worker sở hữu lease mới được cập nhật. */
export async function releaseDisbursementCommitteeExecution(
  requestId: string,
  leaseId: string,
  attemptCount: number,
  errorMessage: string
): Promise<void> {
  const now = new Date();
  const shouldDeadLetter = attemptCount >= MAXIMUM_EXECUTION_ATTEMPT_COUNT;
  const nextAttemptAt = shouldDeadLetter
    ? null
    : new Date(now.getTime() + getDisbursementCommitteeExecutionRetryDelayMs(requestId, attemptCount));
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { requestId, executionStatus: 'PROCESSING', executionLeaseId: leaseId },
    {
      $set: {
        executionStatus: shouldDeadLetter ? 'DEAD_LETTER' : 'PENDING',
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        executionNextAttemptAt: nextAttemptAt,
        executionLastError: errorMessage.slice(0, 500),
        updatedAt: now
      }
    }
  ).exec();
}

/** Gia hạn lease theo request để một worker chậm không bị reclaim giữa lần chờ receipt. */
export async function renewDisbursementCommitteeExecutionLease(
  requestId: string,
  leaseId: string,
  leaseExpiresAt: Date
): Promise<boolean> {
  const now = new Date();
  const result = await DisbursementCommitteeVoteMongoModel.updateOne(
    {
      requestId,
      status: 'APPROVED',
      executionStatus: 'PROCESSING',
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: { $gt: now }
    },
    { $set: { executionLeaseExpiresAt: leaseExpiresAt, updatedAt: now } }
  ).exec();
  return result.modifiedCount === 1;
}
