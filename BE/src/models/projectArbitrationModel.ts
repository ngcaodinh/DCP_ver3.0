import crypto from 'crypto';
import mongoose, { type ClientSession, Schema } from 'mongoose';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';

export type ArbitrationVerdict = 'UPHOLD_PROJECT' | 'REJECT_PROJECT' | 'NO_CONSENSUS' | 'TIMEOUT';
export type ArbitrationVoteDecision = 'UPHOLD_PROJECT' | 'REJECT_PROJECT';
export type ExecutiveRole = typeof EXECUTIVE_CHAIR_ROLE | typeof EXECUTIVE_MEMBER_ROLE;

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
  verdict: ArbitrationVerdict | null;
  abusiveChallengeUserIds: string[];
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const committeeMemberSchema = new Schema<CommitteeSnapshotMember>({
  userId: { type: String, required: true }, role: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  fullName: { type: String, required: true }, walletAddress: { type: String, required: true }
}, { _id: false });
const voteSchema = new Schema<ProjectArbitrationVote>({
  voterUserId: { type: String, required: true }, voterRole: { type: String, enum: [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE], required: true },
  decision: { type: String, enum: ['UPHOLD_PROJECT', 'REJECT_PROJECT'], required: true }, reason: { type: String, required: true },
  markedAbusive: { type: Boolean, required: true, default: false }, votedAt: { type: Date, required: true }
}, { _id: false });
const projectArbitrationSchema = new Schema<ProjectArbitrationRecord>({
  arbitrationId: { type: String, required: true, unique: true }, projectId: { type: String, required: true }, round: { type: Number, required: true },
  status: { type: String, enum: ['PENDING', 'RESOLVED'], required: true, default: 'PENDING' }, openedByChallengeId: { type: String, required: true },
  openedAt: { type: Date, required: true }, deadlineAt: { type: Date, required: true }, committeeSnapshot: { type: [committeeMemberSchema], default: [] },
  requiredMemberVotes: { type: Number, required: true }, votes: { type: [voteSchema], default: [] }, verdict: { type: String, enum: ['UPHOLD_PROJECT', 'REJECT_PROJECT', 'NO_CONSENSUS', 'TIMEOUT'], default: null },
  abusiveChallengeUserIds: { type: [String], default: [] }, resolvedAt: { type: Date, default: null }, createdAt: { type: Date, required: true }, updatedAt: { type: Date, required: true }
}, { collection: 'project_arbitrations' });
projectArbitrationSchema.index({ projectId: 1, round: 1 }, { unique: true });
projectArbitrationSchema.index({ status: 1, deadlineAt: 1 });
projectArbitrationSchema.index({ 'votes.voterUserId': 1, status: 1 });

export const ProjectArbitrationMongoModel = mongoose.models?.ProjectArbitration
  || mongoose.model<ProjectArbitrationRecord>('ProjectArbitration', projectArbitrationSchema);

/** Mở một vụ xét xử cùng snapshot ghế ủy ban của thời điểm có khiếu nại đầu tiên. */
export async function createProjectArbitration(
  payload: Omit<ProjectArbitrationRecord, 'arbitrationId' | 'votes' | 'verdict' | 'abusiveChallengeUserIds' | 'resolvedAt' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<ProjectArbitrationRecord> {
  const now = new Date();
  const created = await ProjectArbitrationMongoModel.create([{
    ...payload, arbitrationId: crypto.randomUUID(), votes: [], verdict: null, abusiveChallengeUserIds: [], resolvedAt: null, createdAt: now, updatedAt: now
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

/** Lấy các vụ còn mở đã vượt quá deadline để worker fail-closed. */
export async function findPendingArbitrationsExpiredBefore(now: Date, limitCount: number): Promise<ProjectArbitrationRecord[]> {
  return ProjectArbitrationMongoModel.find({ status: 'PENDING', deadlineAt: { $lte: now } }).sort({ deadlineAt: 1 }).limit(limitCount).lean<ProjectArbitrationRecord[]>().exec();
}
