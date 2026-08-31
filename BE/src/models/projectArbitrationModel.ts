import crypto from 'crypto';
import mongoose, { type ClientSession, Schema } from 'mongoose';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';

export type ArbitrationVerdict = 'UPHOLD_PROJECT' | 'REJECT_PROJECT' | 'NO_CONSENSUS' | 'TIMEOUT';
export type ArbitrationVoteDecision = 'UPHOLD_PROJECT' | 'REJECT_PROJECT';
export type ExecutiveRole = typeof EXECUTIVE_CHAIR_ROLE | typeof EXECUTIVE_MEMBER_ROLE;
export type ProjectArbitrationOnChainDecisionStatus = 'PENDING' | 'RECORDED' | 'NOT_REQUIRED' | 'NEEDS_RESIGN' | 'DEAD_LETTER';

const MAXIMUM_ON_CHAIN_DECISION_ATTEMPT_COUNT = 8;
const ON_CHAIN_DECISION_RETRY_BASE_DELAY_MS = 30_000;
const ON_CHAIN_DECISION_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;

export interface CommitteeSnapshotMember {
  userId: string;
  role: ExecutiveRole;
  fullName: string;
  walletAddress: string;
}

export interface ProjectArbitrationVote {
  voterUserId: string;
  voterRole: ExecutiveRole;
  decision: ArbitrationVoteDecision;
  reason: string;
  markedAbusive: boolean;
  votedAt: Date;
  signature?: string | null;
  signedPayloadHash?: string | null;
  reasonCommitment?: string | null;
  nonce?: string | null;
  deadline?: Date | null;
  committeeEpoch?: string | null;
}

/** Lưu vòng phiếu đã bị thay thế để chữ ký EIP-712 cũ vẫn truy xuất được khi audit. */
export interface ProjectArbitrationSupersededVoteRound {
  committeeSnapshot: CommitteeSnapshotMember[];
  votes: ProjectArbitrationVote[];
  verdict: ArbitrationVerdict | null;
  supersededAt: Date;
  reason: string;
}

/** Mang roster và hạn mới do relayer xác minh trước khi mở lại một vòng xét xử. */
export interface ProjectArbitrationResignContext {
  committeeSnapshot: CommitteeSnapshotMember[];
  deadlineAt: Date;
}

export interface ProjectArbitrationRecord {
  arbitrationId: string;
  projectId: string;
  round: number;
  status: 'PENDING' | 'RESOLVED';
  openedByChallengeId: string;
  openedAt: Date;
  deadlineAt: Date;
  committeeSnapshot: CommitteeSnapshotMember[];
  requiredMemberVotes: number;
  votes: ProjectArbitrationVote[];
  supersededVoteRounds: ProjectArbitrationSupersededVoteRound[];
  verdict: ArbitrationVerdict | null;
  abusiveChallengeUserIds: string[];
  onChainDecisionTxHash?: string | null;
  onChainDecisionStatus?: ProjectArbitrationOnChainDecisionStatus;
  onChainDecisionRecordedAt?: Date | null;
  onChainDecisionAttemptCount?: number;
  onChainDecisionRecoveryCount?: number;
  onChainDecisionNextAttemptAt?: Date | null;
  onChainDecisionLastError?: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Projection đủ để tính trạng thái biểu quyết trên card portal, không lộ chữ ký hay lý do phiếu. */
export type ProjectArbitrationVotingSummaryRecord = Pick<
  ProjectArbitrationRecord,
  'arbitrationId' | 'projectId' | 'round' | 'openedByChallengeId' | 'deadlineAt' | 'requiredMemberVotes'
> & {
  committeeSnapshot: Array<Pick<CommitteeSnapshotMember, 'userId' | 'role'>>;
  votes: Array<Pick<ProjectArbitrationVote, 'voterUserId' | 'voterRole' | 'decision'>>;
};

const committeeMemberSchema = new Schema<CommitteeSnapshotMember>({
  userId: { type: String, required: true }, role: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  fullName: { type: String, required: true }, walletAddress: { type: String, required: true }
}, { _id: false });
const voteSchema = new Schema<ProjectArbitrationVote>({
  voterUserId: { type: String, required: true }, voterRole: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  decision: { type: String, enum: ['UPHOLD_PROJECT', 'REJECT_PROJECT'], required: true }, reason: { type: String, required: true },
  markedAbusive: { type: Boolean, required: true, default: false }, votedAt: { type: Date, required: true },
  signature: { type: String, default: null }, signedPayloadHash: { type: String, default: null }, reasonCommitment: { type: String, default: null }, nonce: { type: String, default: null }, deadline: { type: Date, default: null }, committeeEpoch: { type: String, default: null }
}, { _id: false });
const supersededVoteRoundSchema = new Schema<ProjectArbitrationSupersededVoteRound>({
  committeeSnapshot: { type: [committeeMemberSchema], required: true },
  votes: { type: [voteSchema], required: true },
  verdict: { type: String, enum: ['UPHOLD_PROJECT', 'REJECT_PROJECT', 'NO_CONSENSUS', 'TIMEOUT'], default: null },
  supersededAt: { type: Date, required: true },
  reason: { type: String, required: true }
}, { _id: false });
const projectArbitrationSchema = new Schema<ProjectArbitrationRecord>({
  arbitrationId: { type: String, required: true, unique: true }, projectId: { type: String, required: true }, round: { type: Number, required: true },
  status: { type: String, enum: ['PENDING', 'RESOLVED'], required: true, default: 'PENDING' }, openedByChallengeId: { type: String, required: true },
  openedAt: { type: Date, required: true }, deadlineAt: { type: Date, required: true }, committeeSnapshot: { type: [committeeMemberSchema], default: [] },
  requiredMemberVotes: { type: Number, required: true }, votes: { type: [voteSchema], default: [] }, supersededVoteRounds: { type: [supersededVoteRoundSchema], default: [] }, verdict: { type: String, enum: ['UPHOLD_PROJECT', 'REJECT_PROJECT', 'NO_CONSENSUS', 'TIMEOUT'], default: null },
  abusiveChallengeUserIds: { type: [String], default: [] }, onChainDecisionTxHash: { type: String, default: null },
  onChainDecisionStatus: { type: String, enum: ['PENDING', 'RECORDED', 'NOT_REQUIRED', 'NEEDS_RESIGN', 'DEAD_LETTER'], required: true, default: 'PENDING' }, onChainDecisionRecordedAt: { type: Date, default: null },
  onChainDecisionAttemptCount: { type: Number, required: true, default: 0 }, onChainDecisionRecoveryCount: { type: Number, required: true, default: 0 }, onChainDecisionNextAttemptAt: { type: Date, default: null }, onChainDecisionLastError: { type: String, default: null },
  resolvedAt: { type: Date, default: null }, createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true }
}, { collection: 'project_arbitrations' });
projectArbitrationSchema.index({ projectId: 1, round: 1 }, { unique: true });
projectArbitrationSchema.index({ status: 1, deadlineAt: 1 });
projectArbitrationSchema.index({ status: 1, onChainDecisionStatus: 1, onChainDecisionNextAttemptAt: 1, resolvedAt: 1 });
projectArbitrationSchema.index({ 'votes.voterUserId': 1, status: 1 });

export const ProjectArbitrationMongoModel = mongoose.models?.ProjectArbitration
  || mongoose.model<ProjectArbitrationRecord>('ProjectArbitration', projectArbitrationSchema);

/** Mở một vụ xét xử cùng snapshot ghế ủy ban của thời điểm có khiếu nại đầu tiên. */
export async function createProjectArbitration(
  payload: Omit<ProjectArbitrationRecord, 'arbitrationId' | 'votes' | 'supersededVoteRounds' | 'verdict' | 'abusiveChallengeUserIds' | 'onChainDecisionTxHash' | 'onChainDecisionStatus' | 'onChainDecisionRecordedAt' | 'onChainDecisionAttemptCount' | 'onChainDecisionRecoveryCount' | 'onChainDecisionNextAttemptAt' | 'onChainDecisionLastError' | 'resolvedAt' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<ProjectArbitrationRecord> {
  const now = new Date();
  const created = await ProjectArbitrationMongoModel.create([{
    ...payload, arbitrationId: crypto.randomUUID(), votes: [], supersededVoteRounds: [], verdict: null, abusiveChallengeUserIds: [], onChainDecisionTxHash: null, onChainDecisionStatus: 'PENDING', onChainDecisionRecordedAt: null, onChainDecisionAttemptCount: 0, onChainDecisionRecoveryCount: 0, onChainDecisionNextAttemptAt: null, onChainDecisionLastError: null, resolvedAt: null, createdAt: now, updatedAt: now
  }], session ? { session } : undefined);
  return created[0].toObject() as ProjectArbitrationRecord;
}

/** Tìm vụ xét xử theo định danh nghiệp vụ. */
export async function findProjectArbitrationById(arbitrationId: string): Promise<ProjectArbitrationRecord | null> {
  return ProjectArbitrationMongoModel.findOne({ arbitrationId }).lean<ProjectArbitrationRecord>().exec();
}

/** Lấy các vụ xét xử còn mở theo deadline cho portal Ủy ban. */
export async function findPendingProjectArbitrations(committeeUserId?: string): Promise<ProjectArbitrationRecord[]> {
  return ProjectArbitrationMongoModel.find({ status: 'PENDING', ...(committeeUserId ? { 'committeeSnapshot.userId': committeeUserId } : {}) }).sort({ deadlineAt: 1 }).lean<ProjectArbitrationRecord[]>().exec();
}

/** Lấy case đang mở theo đúng cặp project/vòng để tab niêm yết chỉ ghép case hiện hành. */
export async function findPendingProjectArbitrationsByProjectRounds(
  projectRounds: Array<{ projectId: string; round: number }>
): Promise<ProjectArbitrationVotingSummaryRecord[]> {
  const normalizedPairs = [...new Map(projectRounds
    .map(item => ({ projectId: String(item.projectId || '').trim(), round: Number(item.round) }))
    .filter(item => item.projectId && Number.isInteger(item.round) && item.round >= 1)
    .map(item => [`${item.projectId}:${item.round}`, item] as const)).values()];
  if (!normalizedPairs.length) return [];
  return ProjectArbitrationMongoModel.find({ status: 'PENDING', $or: normalizedPairs }, {
    _id: 0,
    arbitrationId: 1,
    projectId: 1,
    round: 1,
    openedByChallengeId: 1,
    deadlineAt: 1,
    requiredMemberVotes: 1,
    'committeeSnapshot.userId': 1,
    'committeeSnapshot.role': 1,
    'votes.voterUserId': 1,
    'votes.voterRole': 1,
    'votes.decision': 1
  })
    .sort({ deadlineAt: 1 })
    .lean<ProjectArbitrationVotingSummaryRecord[]>()
    .exec();
}

/** Lấy các vụ còn mở đã vượt quá deadline để worker fail-closed. */
export async function findPendingArbitrationsExpiredBefore(now: Date, limitCount: number): Promise<ProjectArbitrationRecord[]> {
  return ProjectArbitrationMongoModel.find({ status: 'PENDING', deadlineAt: { $lte: now } }).sort({ deadlineAt: 1 }).limit(limitCount).lean<ProjectArbitrationRecord[]>().exec();
}

/** Lấy các phán quyết đã chốt nhưng chưa có event DecisionRecorded để relayer đối soát. */
export async function findResolvedProjectArbitrationsNeedingOnChainDecision(limitCount: number): Promise<ProjectArbitrationRecord[]> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(100, Math.floor(limitCount))) : 20;
  const now = new Date();
  return ProjectArbitrationMongoModel.find({
    status: 'RESOLVED',
    verdict: { $in: ['UPHOLD_PROJECT', 'REJECT_PROJECT'] },
    onChainDecisionStatus: 'PENDING',
    $or: [{ onChainDecisionNextAttemptAt: null }, { onChainDecisionNextAttemptAt: { $lte: now } }]
  })
    .sort({ resolvedAt: 1, arbitrationId: 1 })
    .limit(normalizedLimit)
    .lean<ProjectArbitrationRecord[]>()
    .exec();
}

/** Đánh dấu receipt chỉ một lần, giữ transaction hash đầu tiên để audit không bị thay đổi khi retry. */
export async function markProjectArbitrationDecisionRecorded(
  arbitrationId: string,
  transactionHash: string | null
): Promise<void> {
  const now = new Date();
  await ProjectArbitrationMongoModel.updateOne(
    { arbitrationId, status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: 'RECORDED',
        onChainDecisionTxHash: transactionHash,
        onChainDecisionRecordedAt: now,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: null,
        updatedAt: now
      }
    }
  ).exec();
}

/** Mở lại vòng ký nguyên tử khi epoch hoặc deadline làm toàn bộ chữ ký hiện hữu không còn hợp lệ trên chain. */
export async function markProjectArbitrationDecisionNeedsResign(
  arbitrationId: string,
  reason: string,
  resignContext: ProjectArbitrationResignContext
): Promise<boolean> {
  const now = new Date();
  const normalizedReason = reason.slice(0, 500);
  const reopened = await ProjectArbitrationMongoModel.updateOne(
    { arbitrationId, status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
    [{
      $set: {
        // Pipeline update giữ snapshot, phiếu và verdict cũ trong cùng CAS trước khi mở round mới.
        supersededVoteRounds: {
          $concatArrays: [
            { $ifNull: ['$supersededVoteRounds', []] },
            [{
              committeeSnapshot: '$committeeSnapshot',
              votes: '$votes',
              verdict: '$verdict',
              supersededAt: now,
              reason: { $literal: normalizedReason }
            }]
          ]
        },
        status: 'PENDING',
        verdict: null,
        committeeSnapshot: resignContext.committeeSnapshot,
        deadlineAt: resignContext.deadlineAt,
        votes: [],
        resolvedAt: null,
        onChainDecisionStatus: 'NEEDS_RESIGN',
        onChainDecisionAttemptCount: 0,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: normalizedReason,
        updatedAt: now
      }
    }]
  ).exec();
  return reopened.modifiedCount === 1;
}

/** Tính backoff có jitter xác định cho phán quyết xét xử bị lỗi relay. */
export function getProjectArbitrationOnChainDecisionRetryDelayMs(arbitrationId: string, attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  const baseDelay = Math.min(ON_CHAIN_DECISION_RETRY_MAX_DELAY_MS, ON_CHAIN_DECISION_RETRY_BASE_DELAY_MS * (2 ** exponent));
  const jitterSeed = crypto.createHash('sha256').update(`on-chain-decision:${arbitrationId}:${attemptCount}`).digest()[0] || 0;
  return baseDelay + Math.floor(baseDelay * 0.25 * (jitterSeed / 255));
}

/** Ghi lỗi relay và cô lập phán quyết không thể phát bằng DLQ hữu hạn thay vì retry vô tận. */
export async function releaseProjectArbitrationOnChainDecision(
  arbitrationId: string,
  attemptCount: number,
  errorMessage: string
): Promise<void> {
  const now = new Date();
  const shouldDeadLetter = attemptCount >= MAXIMUM_ON_CHAIN_DECISION_ATTEMPT_COUNT;
  await ProjectArbitrationMongoModel.updateOne(
    { arbitrationId, status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
    {
      $set: {
        onChainDecisionStatus: shouldDeadLetter ? 'DEAD_LETTER' : 'PENDING',
        onChainDecisionNextAttemptAt: shouldDeadLetter
          ? null
          : new Date(now.getTime() + getProjectArbitrationOnChainDecisionRetryDelayMs(arbitrationId, attemptCount)),
        onChainDecisionLastError: errorMessage.slice(0, 500),
        updatedAt: now
      },
      $inc: { onChainDecisionAttemptCount: 1 }
    }
  ).exec();
}

/** Cô lập phán quyết không đủ chữ ký sau thời gian chờ để relayer không cảnh báo lặp vô hạn. */
export async function deadLetterProjectArbitrationOnChainDecision(
  arbitrationId: string,
  errorMessage: string
): Promise<void> {
  await ProjectArbitrationMongoModel.updateOne(
    { arbitrationId, status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
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

/** Khôi phục có chủ đích phán quyết relay đã vào DLQ sau khi service xác minh đủ chữ ký. */
export async function recoverProjectArbitrationOnChainDecision(
  arbitrationId: string,
  session?: ClientSession
): Promise<boolean> {
  const filter = { arbitrationId, status: 'RESOLVED', onChainDecisionStatus: 'DEAD_LETTER' };
  const update = {
    $set: {
      onChainDecisionStatus: 'PENDING',
      onChainDecisionAttemptCount: 0,
      onChainDecisionNextAttemptAt: null,
      onChainDecisionLastError: null,
      updatedAt: new Date()
    },
    $inc: { onChainDecisionRecoveryCount: 1 }
  };
  const result = await (session
    ? ProjectArbitrationMongoModel.updateOne(filter, update, { session })
    : ProjectArbitrationMongoModel.updateOne(filter, update)
  ).exec();
  return result.modifiedCount === 1;
}
