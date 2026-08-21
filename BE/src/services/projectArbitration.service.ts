import { type ClientSession } from 'mongoose';
import { getArbitrationTimeoutMs } from '../constants/projectListingPolicy';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_COMMITTEE_POLICY, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';
import { findActiveExecutiveCommittee } from '../models/authModel';
import { ProjectArbitrationMongoModel, type ArbitrationVerdict, type ProjectArbitrationRecord } from '../models/projectArbitrationModel';
import { createProjectArbitrationFromRepository, findProjectArbitrationByIdFromRepository } from '../repositories/projectArbitrationRepository';
import { updateProjectIfStatus } from '../repositories/projectRepository';
import { ApplicationError } from '../utils/applicationError';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { activateApprovedProject } from './projectActivation.service';

/** Mở vụ xét xử với snapshot ủy ban; thiếu ghế vẫn mở để fail-closed bằng timeout. */
export async function openArbitrationCase(projectId: string, round: number, openedByChallengeId: string, session?: ClientSession): Promise<ProjectArbitrationRecord> {
  const committeeUsers = await findActiveExecutiveCommittee();
  const openedAt = new Date();
  return createProjectArbitrationFromRepository({
    projectId, round, status: 'PENDING', openedByChallengeId, openedAt,
    deadlineAt: new Date(openedAt.getTime() + getArbitrationTimeoutMs()),
    committeeSnapshot: committeeUsers.map(user => ({ userId: user.id, role: user.role as typeof EXECUTIVE_CHAIR_ROLE | typeof EXECUTIVE_MEMBER_ROLE, fullName: user.fullName, walletAddress: user.walletAddress })),
    requiredMemberVotes: EXECUTIVE_COMMITTEE_POLICY.requiredMemberVotes
  }, session);
}

/** Tính phán quyết thuần từ snapshot và phiếu để unit test độc lập. */
export function evaluateVerdict(record: ProjectArbitrationRecord): ArbitrationVerdict | null {
  const sideWins = (decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'): boolean => {
    const votes = record.votes.filter(vote => vote.decision === decision);
    return votes.some(vote => vote.voterRole === EXECUTIVE_CHAIR_ROLE) && votes.filter(vote => vote.voterRole === EXECUTIVE_MEMBER_ROLE).length >= record.requiredMemberVotes;
  };
  if (sideWins('UPHOLD_PROJECT')) return 'UPHOLD_PROJECT';
  if (sideWins('REJECT_PROJECT')) return 'REJECT_PROJECT';
  return record.votes.length >= record.committeeSnapshot.length ? 'NO_CONSENSUS' : null;
}

/** Ghi một phiếu nguyên tử, sau đó áp dụng phán quyết nếu đủ điều kiện. */
export async function voteOnArbitration(voterUserId: string, input: { arbitrationId: string; decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'; reason: string; markedAbusive: boolean }): Promise<ProjectArbitrationRecord> {
  const now = new Date();
  const current = await findProjectArbitrationByIdFromRepository(input.arbitrationId);
  if (!current) throw new ApplicationError('Không tìm thấy vụ xét xử.', 404, 'NOT_FOUND');
  if (current.status !== 'PENDING') throw new ApplicationError('Vụ xét xử đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
  const snapshotMember = current.committeeSnapshot.find(member => member.userId === voterUserId);
  if (!snapshotMember) throw new ApplicationError('Bạn không thuộc snapshot ủy ban của vụ việc này.', 403, 'NOT_COMMITTEE_MEMBER');
  const updated = await ProjectArbitrationMongoModel.findOneAndUpdate(
    { arbitrationId: input.arbitrationId, status: 'PENDING', 'votes.voterUserId': { $ne: voterUserId }, 'committeeSnapshot.userId': voterUserId },
    { $push: { votes: { voterUserId, voterRole: snapshotMember.role, decision: input.decision, reason: input.reason, markedAbusive: input.markedAbusive, votedAt: now } }, $set: { updatedAt: now } },
    { returnDocument: 'after' }
  ).lean<ProjectArbitrationRecord>().exec();
  if (!updated) {
    const latest = await findProjectArbitrationByIdFromRepository(input.arbitrationId);
    if (!latest) throw new ApplicationError('Không tìm thấy vụ xét xử.', 404, 'NOT_FOUND');
    if (latest.status !== 'PENDING') throw new ApplicationError('Vụ xét xử đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
    if (latest.votes.some(vote => vote.voterUserId === voterUserId)) throw new ApplicationError('Bạn đã bỏ phiếu cho vụ việc này.', 409, 'ALREADY_VOTED');
    throw new ApplicationError('Bạn không thuộc snapshot ủy ban của vụ việc này.', 403, 'NOT_COMMITTEE_MEMBER');
  }
  const verdict = evaluateVerdict(updated);
  return verdict ? resolveArbitration(updated, verdict) : updated;
}

/** Chốt bản ghi xét xử và trạng thái REJECT trong cùng transaction trước khi gọi blockchain. */
async function resolveArbitration(record: ProjectArbitrationRecord, verdict: ArbitrationVerdict): Promise<ProjectArbitrationRecord> {
  const resolvedAt = new Date();
  const resolved = await runMongoTransaction(async session => {
    const updated = await ProjectArbitrationMongoModel.findOneAndUpdate(
      { arbitrationId: record.arbitrationId, status: 'PENDING' },
      { $set: { status: 'RESOLVED', verdict, abusiveChallengeUserIds: [], resolvedAt, updatedAt: resolvedAt } },
      { returnDocument: 'after', session }
    ).lean<ProjectArbitrationRecord>().exec();
    if (!updated) return null;
    if (verdict !== 'UPHOLD_PROJECT') {
      const rejected = await updateProjectIfStatus(record.projectId, 'DISPUTED', {
        status: 'REJECTED',
        rejectionReason: verdict === 'TIMEOUT' ? 'Ủy ban Điều hành không ra phán quyết trong thời hạn.' : 'Ủy ban Điều hành chấp nhận khiếu nại hoặc không đạt đồng thuận.',
        updatedAt: resolvedAt
      }, session);
      if (!rejected) throw new ApplicationError('Dự án đã thay đổi trạng thái, không thể chốt xét xử.', 409, 'INVALID_STATUS_TRANSITION');
    }
    return updated;
  });
  if (!resolved) return record;
  if (verdict === 'UPHOLD_PROJECT') await activateApprovedProject(record.projectId, 'DISPUTED');
  return resolved;
}

/** Fail-closed các vụ quá hạn do worker gọi. */
export async function resolveArbitrationByTimeout(arbitrationId: string): Promise<ProjectArbitrationRecord | null> {
  const record = await findProjectArbitrationByIdFromRepository(arbitrationId);
  return !record || record.status !== 'PENDING' ? null : resolveArbitration(record, 'TIMEOUT');
}
