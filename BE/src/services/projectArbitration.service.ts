import { type ClientSession } from 'mongoose';
import { getArbitrationTimeoutMs } from '../constants/projectListingPolicy';
import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_COMMITTEE_POLICY, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';
import { findActiveExecutiveCommittee } from '../models/authModel';
import { ProjectArbitrationMongoModel, recoverProjectArbitrationOnChainDecision, type ArbitrationVerdict, type ProjectArbitrationRecord } from '../models/projectArbitrationModel';
import { createProjectArbitrationFromRepository, findProjectArbitrationByIdFromRepository } from '../repositories/projectArbitrationRepository';
import { findProjectChallengesFromRepository } from '../repositories/projectChallengeRepository';
import { aggregateDonationSummaryByProjectId } from '../models/donationModel';
import { releaseAuditorOpenCase } from '../models/auditorStakeGuardModel';
import { findProjectById, updateProjectIfStatus } from '../repositories/projectRepository';
import { ApplicationError } from '../utils/applicationError';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { activateApprovedProject } from './projectActivation.service';
import { closeRejectedProject } from './projectClosure.service';
import {
  prepareCommitteeVoteSignature,
  readCommitteeEpochFromChain,
  verifyCommitteeVoteSignature,
  type CommitteeVoteSignaturePayload,
  type SubmittedCommitteeVoteSignature
} from './committeeGovernanceEip712.service';
import { selectCommitteeDecisionThresholdSignatures } from './committeeDecisionSignatureSelection.service';

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

/** Tính phán quyết thuần; chỉ cho phép hủy khi đúng toàn bộ năm ghế snapshot cùng lựa chọn. */
export function evaluateVerdict(record: ProjectArbitrationRecord): ArbitrationVerdict | null {
  const sideWins = (decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'): boolean => {
    const votes = record.votes.filter(vote => vote.decision === decision);
    return votes.some(vote => vote.voterRole === EXECUTIVE_CHAIR_ROLE) && votes.filter(vote => vote.voterRole === EXECUTIVE_MEMBER_ROLE).length >= record.requiredMemberVotes;
  };
  if (sideWins('UPHOLD_PROJECT')) return 'UPHOLD_PROJECT';
  const expectedCommitteeSeatCount = EXECUTIVE_COMMITTEE_POLICY.requiredChairVotes + EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats;
  const rejectVotesByUserId = new Map(record.votes
    .filter(vote => vote.decision === 'REJECT_PROJECT')
    .map(vote => [vote.voterUserId, vote]));
  const hasFullCommitteeSnapshot = record.committeeSnapshot.length === expectedCommitteeSeatCount
    && record.committeeSnapshot.filter(member => member.role === EXECUTIVE_CHAIR_ROLE).length === EXECUTIVE_COMMITTEE_POLICY.requiredChairVotes
    && record.committeeSnapshot.filter(member => member.role === EXECUTIVE_MEMBER_ROLE).length === EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats
    && new Set(record.committeeSnapshot.map(member => member.userId)).size === expectedCommitteeSeatCount;
  // Hủy dự án khóa tiền vĩnh viễn nên cả năm ghế trong snapshot hợp lệ phải tự mình chọn hủy.
  if (hasFullCommitteeSnapshot
    && record.votes.length === expectedCommitteeSeatCount
    && rejectVotesByUserId.size === expectedCommitteeSeatCount
    && record.committeeSnapshot.every(member => rejectVotesByUserId.get(member.userId)?.voterRole === member.role)) {
    return 'REJECT_PROJECT';
  }
  return record.committeeSnapshot.length > 0 && record.votes.length >= record.committeeSnapshot.length ? 'NO_CONSENSUS' : null;
}

/** Khóa ký và ghi phiếu nếu challenge gốc của vụ xét xử không còn tồn tại ở đúng vòng. */
async function assertArbitrationChallengeIntegrity(record: Pick<ProjectArbitrationRecord, 'projectId' | 'round' | 'openedByChallengeId'>): Promise<void> {
  const challenges = await findProjectChallengesFromRepository(record.projectId, record.round) ?? [];
  if (!challenges.some(challenge => challenge.challengeId === record.openedByChallengeId)) {
    throw new ApplicationError('Vụ xét xử thiếu khiếu nại gốc của vòng hiện tại nên không thể biểu quyết.', 409, 'ARBITRATION_INTEGRITY_ERROR');
  }
}

/** Ghi một phiếu nguyên tử, sau đó áp dụng phán quyết nếu đủ điều kiện. */
export async function prepareArbitrationVoteSignature(voterUserId: string, input: { arbitrationId: string; decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'; reason: string }): Promise<CommitteeVoteSignaturePayload | null> {
  const current = await findProjectArbitrationByIdFromRepository(input.arbitrationId);
  if (!current) throw new ApplicationError('Không tìm thấy vụ xét xử.', 404, 'NOT_FOUND');
  if (current.status !== 'PENDING' || current.deadlineAt <= new Date()) throw new ApplicationError('Vụ xét xử không còn hiệu lực.', 409, 'INVALID_STATUS_TRANSITION');
  if (!current.committeeSnapshot.some(member => member.userId === voterUserId)) throw new ApplicationError('Bạn không thuộc snapshot ủy ban của vụ việc này.', 403, 'NOT_COMMITTEE_MEMBER');
  await assertArbitrationChallengeIntegrity(current);
  return prepareCommitteeVoteSignature('ARBITRATION', input.arbitrationId, input.decision, voterUserId, input.reason, current.deadlineAt);
}

/** Ghi một phiếu nguyên tử, xác minh chữ ký EIP-712 và chốt phán quyết khi đạt điều kiện. */
export async function voteOnArbitration(voterUserId: string, input: { arbitrationId: string; decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'; reason: string; markedAbusive?: boolean; donationLockRiskAcknowledged?: boolean; eip712Signature?: SubmittedCommitteeVoteSignature }): Promise<ProjectArbitrationRecord> {
  const now = new Date();
  const current = await findProjectArbitrationByIdFromRepository(input.arbitrationId);
  if (!current) throw new ApplicationError('Không tìm thấy vụ xét xử.', 404, 'NOT_FOUND');
  if (current.status !== 'PENDING') throw new ApplicationError('Vụ xét xử đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
  if (current.deadlineAt <= now) throw new ApplicationError('Vụ xét xử đã hết hạn.', 409, 'REQUEST_EXPIRED');
  const snapshotMember = current.committeeSnapshot.find(member => member.userId === voterUserId);
  if (!snapshotMember) throw new ApplicationError('Bạn không thuộc snapshot ủy ban của vụ việc này.', 403, 'NOT_COMMITTEE_MEMBER');
  await assertArbitrationChallengeIntegrity(current);
  if (input.decision === 'REJECT_PROJECT') {
    const [project, donationSummary] = await Promise.all([
      findProjectById(current.projectId),
      aggregateDonationSummaryByProjectId(current.projectId)
    ]);
    // Arbitration có thể đang DISPUTED hoặc ACTIVE; mọi dự án có donation INDEXED đều phải xác nhận trước khi gửi phiếu hủy.
    if (project && donationSummary.totalAmount > 0 && input.donationLockRiskAcknowledged !== true) {
      throw new ApplicationError('Bạn phải xác nhận rủi ro khóa vĩnh viễn tiền quyên góp trước khi bỏ phiếu hủy dự án.', 409, 'DONATION_LOCK_RISK_NOT_ACKNOWLEDGED');
    }
  }
  const verifiedSignature = await verifyCommitteeVoteSignature({
    kind: 'ARBITRATION', businessId: input.arbitrationId, decision: input.decision,
    expectedWalletAddress: snapshotMember.walletAddress, voterUserId, reason: input.reason, submitted: input.eip712Signature
  });
  // Chốt thời điểm ngay trước CAS để không ghi phiếu nếu hạn vụ việc đã qua trong lúc xác minh chữ ký.
  const voteRecordedAt = new Date();
  const updated = await ProjectArbitrationMongoModel.findOneAndUpdate(
    { arbitrationId: input.arbitrationId, status: 'PENDING', deadlineAt: { $gt: voteRecordedAt }, 'votes.voterUserId': { $ne: voterUserId }, 'committeeSnapshot.userId': voterUserId },
    { $push: { votes: { voterUserId, voterRole: snapshotMember.role, decision: input.decision, reason: input.reason, markedAbusive: input.markedAbusive === true, votedAt: voteRecordedAt, signature: verifiedSignature.signature, signedPayloadHash: verifiedSignature.signedPayloadHash, reasonCommitment: verifiedSignature.reasonCommitment, nonce: verifiedSignature.nonce, deadline: verifiedSignature.deadline, committeeEpoch: verifiedSignature.committeeEpoch } }, $set: { updatedAt: voteRecordedAt } },
    { returnDocument: 'after' }
  ).lean<ProjectArbitrationRecord>().exec();
  if (!updated) {
    const latest = await findProjectArbitrationByIdFromRepository(input.arbitrationId);
    if (!latest) throw new ApplicationError('Không tìm thấy vụ xét xử.', 404, 'NOT_FOUND');
    if (latest.status !== 'PENDING') throw new ApplicationError('Vụ xét xử đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
    if (latest.deadlineAt <= new Date()) throw new ApplicationError('Vụ xét xử đã hết hạn.', 409, 'REQUEST_EXPIRED');
    if (latest.votes.some(vote => vote.voterUserId === voterUserId)) throw new ApplicationError('Bạn đã bỏ phiếu cho vụ việc này.', 409, 'ALREADY_VOTED');
    throw new ApplicationError('Bạn không thuộc snapshot ủy ban của vụ việc này.', 403, 'NOT_COMMITTEE_MEMBER');
  }
  const verdict = evaluateVerdict(updated);
  return verdict ? resolveArbitration(updated, verdict) : updated;
}

/** Chốt bản ghi xét xử và chỉ chuyển dự án sang REJECTED khi phán quyết là hủy 5/5. */
async function resolveArbitration(record: ProjectArbitrationRecord, verdict: ArbitrationVerdict): Promise<ProjectArbitrationRecord> {
  const resolvedAt = new Date();
  const requiresOnChainDecision = verdict === 'UPHOLD_PROJECT' || verdict === 'REJECT_PROJECT';
  const resolution = await runMongoTransaction(async session => {
    const updated = await ProjectArbitrationMongoModel.findOneAndUpdate(
      { arbitrationId: record.arbitrationId, status: 'PENDING' },
      {
        $set: {
          status: 'RESOLVED',
          verdict,
          abusiveChallengeUserIds: [],
          onChainDecisionStatus: requiresOnChainDecision ? 'PENDING' : 'NOT_REQUIRED',
          onChainDecisionNextAttemptAt: null,
          resolvedAt,
          updatedAt: resolvedAt
        }
      },
      { returnDocument: 'after', session }
    ).lean<ProjectArbitrationRecord>().exec();
    if (!updated) return { record: null, requiresOnChainClosure: false };
    if (verdict === 'REJECT_PROJECT') {
      const rejectionPayload = {
        status: 'REJECTED' as const,
        rejectionReason: 'Cả năm ghế Ủy ban Điều hành đồng thuận hủy dự án.',
        updatedAt: resolvedAt
      };
      const rejectedFromDispute = await updateProjectIfStatus(record.projectId, 'DISPUTED', rejectionPayload, session);
      // Vòng ký lại có thể lật dự án đã ACTIVE sang hủy; chỉ CAS từ ACTIVE mới được phép đi theo nhánh đó.
      const rejectedFromActive = rejectedFromDispute
        ? null
        : await updateProjectIfStatus(record.projectId, 'ACTIVE', {
          ...rejectionPayload,
          closureState: 'PENDING',
          closureClaimedAt: null,
          closureAttemptCount: 0,
          closureNextAttemptAt: null,
          closureLastError: null
        }, session);
      if (!rejectedFromDispute && !rejectedFromActive) {
        throw new ApplicationError('Dự án đã thay đổi trạng thái, không thể chốt xét xử.', 409, 'INVALID_STATUS_TRANSITION');
      }
      return { record: updated, requiresOnChainClosure: Boolean(rejectedFromActive) };
    }
    return { record: updated, requiresOnChainClosure: false };
  });
  if (!resolution.record) return record;
  const resolved = resolution.record;
  const guardCaseId = `PROJECT_CHALLENGE:${resolved.projectId}:${resolved.round}`;
  const challenges = await findProjectChallengesFromRepository(resolved.projectId, resolved.round) ?? [];
  await Promise.all(challenges.map(challenge => releaseAuditorOpenCase(challenge.challengerUserId, guardCaseId)));
  if (resolution.requiresOnChainClosure) await closeRejectedProject(record.projectId);
  const isFirstVoteRound = (record.supersededVoteRounds?.length || 0) === 0;
  const shouldActivateProject = verdict === 'UPHOLD_PROJECT'
    || (isFirstVoteRound && (verdict === 'NO_CONSENSUS' || verdict === 'TIMEOUT'));
  if (shouldActivateProject) {
    const project = await findProjectById(record.projectId);
    // TIMEOUT/NO_CONSENSUS chỉ là chưa xét xử ở vòng đầu; vòng ký lại giữ nguyên trạng thái trước đó, còn UPHOLD mới vẫn có hiệu lực.
    if ((project?.status === 'DISPUTED' || project?.status === 'REJECTED')
      && !['PENDING', 'SYNCED', 'FAILED'].includes(project.closureState || 'NOT_REQUIRED')) {
      await activateApprovedProject(record.projectId, project.status);
    }
  }
  return resolved;
}

/** Fail-closed các vụ quá hạn do worker gọi. */
export async function resolveArbitrationByTimeout(arbitrationId: string): Promise<ProjectArbitrationRecord | null> {
  const record = await findProjectArbitrationByIdFromRepository(arbitrationId);
  return !record || record.status !== 'PENDING' ? null : resolveArbitration(record, 'TIMEOUT');
}

/** Khôi phục relay on-chain sau DLQ chỉ khi chữ ký hợp lệ và epoch on-chain vẫn khớp để không tạo vòng lặp vô ích. */
export async function recoverDeadLetterProjectArbitrationOnChainDecision(
  arbitrationId: string,
  session?: ClientSession
): Promise<void> {
  const record = await findProjectArbitrationByIdFromRepository(arbitrationId);
  // Chỉ DLQ hợp lệ cần đọc blockchain; trạng thái khác phải bị từ chối trước khi tốn RPC.
  if (!record || record.onChainDecisionStatus !== 'DEAD_LETTER') {
    throw new ApplicationError('Chỉ có thể khôi phục phán quyết xét xử đang DEAD_LETTER.', 409, 'INVALID_STATUS_TRANSITION');
  }
  if (record.verdict !== 'UPHOLD_PROJECT' && record.verdict !== 'REJECT_PROJECT') {
    throw new ApplicationError('Phán quyết không có bên thắng hợp lệ để khôi phục relay on-chain.', 409, 'INVALID_STATUS_TRANSITION');
  }
  const signatureSelection = selectCommitteeDecisionThresholdSignatures(record.committeeSnapshot, record.votes, record.verdict);
  if (signatureSelection.status !== 'READY') {
    throw new ApplicationError('Phán quyết không có đủ chữ ký EIP-712 hợp lệ để khôi phục relay on-chain.', 409, 'INVALID_STATUS_TRANSITION');
  }
  const currentEpoch = await readCommitteeEpochFromChain();
  if (currentEpoch !== signatureSelection.committeeEpoch) {
    throw new ApplicationError('Epoch Ủy ban đã đổi sau khi thu thập chữ ký; phán quyết cần ký lại chứ không khôi phục relay được.', 409, 'INVALID_STATUS_TRANSITION');
  }
  const recovered = session
    ? await recoverProjectArbitrationOnChainDecision(arbitrationId, session)
    : await recoverProjectArbitrationOnChainDecision(arbitrationId);
  if (!recovered) {
    throw new ApplicationError('Chỉ có thể khôi phục phán quyết xét xử đang DEAD_LETTER.', 409, 'INVALID_STATUS_TRANSITION');
  }
}
