import { EXECUTIVE_CHAIR_ROLE, EXECUTIVE_COMMITTEE_POLICY, EXECUTIVE_MEMBER_ROLE } from '../constants/governanceRoles';
import { findActiveExecutiveCommittee } from '../models/authModel';
import {
  createDisbursementCommitteeVote,
  DisbursementCommitteeVoteMongoModel,
  findDisbursementCommitteeVoteByRequestId,
  findPendingDisbursementCommitteeVotes,
  recoverDisbursementCommitteeExecution,
  type DisbursementCommitteeDecision,
  type DisbursementCommitteeRecoveryScope,
  type DisbursementCommitteeSnapshotMember,
  type DisbursementCommitteeVoteRecord
} from '../models/disbursementCommitteeVoteModel';
import {
  findDisbursementByRequestId,
  findDisbursementsByRequestIds,
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { recordAdminAuditLog } from './audit-log.service';
import { getExecutiveActiveProjectDetail, getExecutiveActiveProjectDetails } from './executiveProjectMonitoring.service';
import { ApplicationError } from '../utils/applicationError';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import type { ClientSession } from 'mongoose';
import {
  prepareCommitteeVoteSignature,
  verifyCommitteeVoteSignature,
  type CommitteeVoteSignaturePayload,
  type SubmittedCommitteeVoteSignature
} from './committeeGovernanceEip712.service';
import { selectCommitteeDecisionThresholdSignatures } from './committeeDecisionSignatureSelection.service';

export type VoteOnDisbursementInput = {
  requestId: string;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
  gpsRiskAcknowledged?: boolean;
  eip712Signature?: SubmittedCommitteeVoteSignature;
  requestContext?: AuditRequestContext;
};

type PendingDisbursementCursor = {
  deadlineAt: string;
  committeeVoteId: string;
};

export const DISBURSEMENT_COMMITTEE_RESIGN_VOTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Giải mã cursor opaque và từ chối dữ liệu sai thay vì để Mongo nhận filter không xác định. */
function decodePendingDisbursementCursor(cursor: string | null): { deadlineAt: Date; committeeVoteId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<PendingDisbursementCursor>;
    const deadlineAt = new Date(decoded.deadlineAt || '');
    if (!decoded.committeeVoteId || Number.isNaN(deadlineAt.getTime())) throw new Error('invalid cursor');
    return { deadlineAt, committeeVoteId: decoded.committeeVoteId };
  } catch {
    throw new ApplicationError('Cursor hàng chờ giải ngân không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
}

/** Mã hóa cursor duy nhất theo deadline và committee case để không bỏ sót case có cùng thời hạn. */
function encodePendingDisbursementCursor(cursor: { deadlineAt: Date; committeeVoteId: string } | null): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify({
    deadlineAt: cursor.deadlineAt.toISOString(),
    committeeVoteId: cursor.committeeVoteId
  })).toString('base64url');
}

/** Xác định các mức GPS phải được thành viên xác nhận lại trước khi có thể biểu quyết. */
function requiresGpsRiskAcknowledgement(deviationLevel: string): boolean {
  return deviationLevel === 'DEVIATED' || deviationLevel === 'CRITICAL';
}

/** Đánh giá thuần theo snapshot: Chủ tịch và tối thiểu hai Ủy viên phải cùng một phía. */
export function evaluateDisbursementVerdict(record: DisbursementCommitteeVoteRecord): 'APPROVED' | 'REJECTED' | null {
  const sideWins = (decision: 'APPROVE' | 'REJECT'): boolean => {
    const votes = record.votes.filter(vote => vote.decision === decision);
    return votes.some(vote => vote.voterRole === EXECUTIVE_CHAIR_ROLE)
      && votes.filter(vote => vote.voterRole === EXECUTIVE_MEMBER_ROLE).length >= record.requiredMemberVotes;
  };
  if (sideWins('APPROVE')) return 'APPROVED';
  if (sideWins('REJECT')) return 'REJECTED';
  return record.votes.length >= record.committeeSnapshot.length ? 'REJECTED' : null;
}

/** Xác minh roster đầy đủ 1 Chair và 4 Member trước khi tạo nghĩa vụ on-chain hoặc snapshot case. */
export async function ensureExecutiveCommitteeRosterReady(): Promise<Awaited<ReturnType<typeof findActiveExecutiveCommittee>>> {
  const committeeUsers = await findActiveExecutiveCommittee();
  const chairCount = committeeUsers.filter(user => user.role === EXECUTIVE_CHAIR_ROLE).length;
  const memberCount = committeeUsers.filter(user => user.role === EXECUTIVE_MEMBER_ROLE).length;
  const uniqueUserIds = new Set(committeeUsers.map(user => user.id));
  const normalizedWalletAddresses = committeeUsers.map(user => (user.governanceWalletAddress || user.walletAddress || '').trim().toLowerCase());
  const uniqueWalletAddresses = new Set(normalizedWalletAddresses.filter(Boolean));
  if (
    chairCount !== EXECUTIVE_COMMITTEE_POLICY.requiredChairVotes
    || memberCount !== EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats
    || uniqueUserIds.size !== committeeUsers.length
    || uniqueWalletAddresses.size !== committeeUsers.length
  ) {
    throw new ApplicationError('Ủy ban Điều hành chưa có roster hợp lệ 1 Chủ tịch và 4 Ủy viên. Không thể mở yêu cầu giải ngân.', 409, 'COMMITTEE_ROSTER_INVALID');
  }
  return committeeUsers;
}

/** Chuyển roster đang hoạt động thành snapshot bất biến để một round vote luôn xác định đúng signer được phép. */
export function createDisbursementCommitteeSnapshot(
  committeeUsers: Awaited<ReturnType<typeof findActiveExecutiveCommittee>>
): DisbursementCommitteeSnapshotMember[] {
  return committeeUsers.map(user => ({
    userId: user.id,
    role: user.role as typeof EXECUTIVE_CHAIR_ROLE | typeof EXECUTIVE_MEMBER_ROLE,
    fullName: user.fullName,
    walletAddress: user.walletAddress,
    governanceWalletAddress: user.governanceWalletAddress || null
  }));
}

/** Mở case vote cùng thời điểm request được tạo; ghế được snapshot để không đổi luật giữa chừng. */
export async function openDisbursementCommitteeCase(
  requestId: string,
  deadlineAt: Date,
  session?: ClientSession
): Promise<DisbursementCommitteeVoteRecord> {
  const committeeUsers = await ensureExecutiveCommitteeRosterReady();
  try {
    return await createDisbursementCommitteeVote({
      requestId,
      status: 'PENDING',
      committeeSnapshot: createDisbursementCommitteeSnapshot(committeeUsers),
      requiredMemberVotes: EXECUTIVE_COMMITTEE_POLICY.requiredMemberVotes,
      openedAt: new Date(),
      deadlineAt
    }, session);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existingCase = await findDisbursementCommitteeVoteByRequestId(requestId);
      if (existingCase) return existingCase;
    }
    throw error;
  }
}

/** Chuẩn bị domain/epoch/nonce từ chain cho MetaMask trước khi client gửi phiếu bất biến. */
export async function prepareDisbursementVoteSignature(
  voterUserId: string,
  input: Pick<VoteOnDisbursementInput, 'requestId' | 'decision' | 'reason'>
): Promise<CommitteeVoteSignaturePayload | null> {
  const current = await findDisbursementCommitteeVoteByRequestId(input.requestId);
  if (!current) throw new ApplicationError('Không tìm thấy hồ sơ bỏ phiếu giải ngân.', 404, 'NOT_FOUND');
  if (current.status !== 'PENDING' || current.deadlineAt <= new Date()) throw new ApplicationError('Hồ sơ bỏ phiếu giải ngân không còn hiệu lực.', 409, 'INVALID_STATUS_TRANSITION');
  if (!current.committeeSnapshot.some(member => member.userId === voterUserId)) throw new ApplicationError('Bạn không thuộc snapshot Ủy ban của yêu cầu này.', 403, 'NOT_COMMITTEE_MEMBER');
  return prepareCommitteeVoteSignature('DISBURSEMENT', input.requestId, input.decision, voterUserId, input.reason, current.deadlineAt);
}

/** Ghi một phiếu CAS, chốt kết quả nếu đủ 3/5 và tuyệt đối không gọi hợp đồng từ request người dùng. */
export async function voteOnDisbursement(
  voterUserId: string,
  input: VoteOnDisbursementInput
): Promise<DisbursementCommitteeVoteRecord> {
  const current = await findDisbursementCommitteeVoteByRequestId(input.requestId);
  if (!current) throw new ApplicationError('Không tìm thấy hồ sơ bỏ phiếu giải ngân.', 404, 'NOT_FOUND');
  if (current.status !== 'PENDING') throw new ApplicationError('Hồ sơ bỏ phiếu giải ngân đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
  if (current.deadlineAt <= new Date()) throw new ApplicationError('Hồ sơ bỏ phiếu giải ngân đã hết hạn.', 409, 'REQUEST_EXPIRED');
  const snapshotMember = current.committeeSnapshot.find(member => member.userId === voterUserId);
  if (!snapshotMember) throw new ApplicationError('Bạn không thuộc snapshot Ủy ban của yêu cầu này.', 403, 'NOT_COMMITTEE_MEMBER');

  const disbursement = await findDisbursementByRequestId(input.requestId);
  if (!disbursement) throw new ApplicationError('Không tìm thấy yêu cầu giải ngân.', 404, 'NOT_FOUND');
  const monitoring = await getExecutiveActiveProjectDetail(disbursement.projectId);
  if (requiresGpsRiskAcknowledgement(monitoring.highestDeviationLevel) && input.gpsRiskAcknowledged !== true) {
    throw new ApplicationError('Bạn phải xác nhận đã xem cảnh báo GPS trước khi biểu quyết.', 400, 'VALIDATION_ERROR');
  }

  const now = new Date();
  const verifiedSignature = await verifyCommitteeVoteSignature({
    kind: 'DISBURSEMENT',
    businessId: input.requestId,
    decision: input.decision,
    expectedWalletAddress: snapshotMember.governanceWalletAddress || snapshotMember.walletAddress,
    voterUserId,
    reason: input.reason,
    submitted: input.eip712Signature
  });
  const updated = await DisbursementCommitteeVoteMongoModel.findOneAndUpdate(
    {
      requestId: input.requestId,
      status: 'PENDING',
      deadlineAt: { $gt: now },
      'votes.voterUserId': { $ne: voterUserId },
      'committeeSnapshot.userId': voterUserId
    },
    {
      $push: {
        votes: {
          voterUserId,
          voterRole: snapshotMember.role,
          decision: input.decision,
          reason: input.reason.trim(),
          votedAt: now,
          signature: verifiedSignature.signature,
          signedPayloadHash: verifiedSignature.signedPayloadHash,
          reasonCommitment: verifiedSignature.reasonCommitment,
          nonce: verifiedSignature.nonce,
          deadline: verifiedSignature.deadline,
          committeeEpoch: verifiedSignature.committeeEpoch
        }
      },
      $set: { updatedAt: now }
    },
    { returnDocument: 'after' }
  ).lean<DisbursementCommitteeVoteRecord>().exec();

  if (!updated) {
    const latest = await findDisbursementCommitteeVoteByRequestId(input.requestId);
    if (!latest) throw new ApplicationError('Không tìm thấy hồ sơ bỏ phiếu giải ngân.', 404, 'NOT_FOUND');
    if (latest.status !== 'PENDING') throw new ApplicationError('Hồ sơ bỏ phiếu giải ngân đã đóng.', 409, 'INVALID_STATUS_TRANSITION');
    if (latest.deadlineAt <= now) throw new ApplicationError('Hồ sơ bỏ phiếu giải ngân đã hết hạn.', 409, 'REQUEST_EXPIRED');
    if (latest.votes.some(vote => vote.voterUserId === voterUserId)) throw new ApplicationError('Bạn đã bỏ phiếu cho yêu cầu này.', 409, 'ALREADY_VOTED');
    throw new ApplicationError('Bạn không thuộc snapshot Ủy ban của yêu cầu này.', 403, 'NOT_COMMITTEE_MEMBER');
  }

  const verdict = evaluateDisbursementVerdict(updated);
  const resolved = verdict
    ? await resolveDisbursementCommitteeCase(updated, verdict)
    : updated;
  await recordAdminAuditLog({
    actorType: 'ADMIN',
    adminId: voterUserId,
    adminRole: snapshotMember.role,
    actionType: input.decision === 'APPROVE' ? 'DISBURSEMENT_COMMITTEE_VOTE_APPROVE' : 'DISBURSEMENT_COMMITTEE_VOTE_REJECT',
    targetId: input.requestId,
    targetType: 'DISBURSEMENT_REQUEST',
    requestContext: input.requestContext,
    reason: input.reason.trim(),
    context: {
      requestId: input.requestId,
      vote: input.decision,
      outcome: resolved.status,
      gpsRiskAcknowledged: input.gpsRiskAcknowledged === true
    }
  });
  return resolved;
}

/** Chốt status một lần; nhánh REJECTED cập nhật Mongo request, nhánh APPROVED để worker chấp hành sau. */
async function resolveDisbursementCommitteeCase(
  record: DisbursementCommitteeVoteRecord,
  verdict: 'APPROVED' | 'REJECTED'
): Promise<DisbursementCommitteeVoteRecord> {
  const resolvedAt = new Date();
  const resolved = await DisbursementCommitteeVoteMongoModel.findOneAndUpdate(
    { requestId: record.requestId, status: 'PENDING' },
    {
      $set: {
        status: verdict,
        resolvedAt,
        onChainDecisionStatus: 'PENDING',
        onChainDecisionTxHash: null,
        onChainDecisionRecordedAt: null,
        onChainDecisionAttemptCount: 0,
        onChainDecisionNextAttemptAt: null,
        onChainDecisionLastError: null,
        // Worker kỹ thuật chỉ nhận case APPROVED sau khi relayer xác nhận DecisionRecorded on-chain.
        ...(verdict === 'APPROVED' ? { executionStatus: 'WAITING_ON_CHAIN_DECISION' } : {}),
        updatedAt: resolvedAt
      }
    },
    { returnDocument: 'after' }
  ).lean<DisbursementCommitteeVoteRecord>().exec();
  if (!resolved) return (await findDisbursementCommitteeVoteByRequestId(record.requestId)) || record;
  if (verdict === 'REJECTED') {
    await updateDisbursementByRequestIdWithCondition(record.requestId, { status: 'PENDING' }, { status: 'REJECTED' });
  }
  return resolved;
}

/** Đóng fail-closed các case quá hạn và đưa relay state vào DLQ vì chúng không thể có bộ chữ ký hợp lệ. */
export async function expireOverdueDisbursementCommitteeCases(maximumCases: number = 100): Promise<number> {
  const boundedMaximumCases = Math.max(1, Math.min(100, Math.floor(maximumCases)));
  const now = new Date();
  let expiredCount = 0;
  for (let index = 0; index < boundedMaximumCases; index += 1) {
    const expiredCase = await DisbursementCommitteeVoteMongoModel.findOneAndUpdate(
      { status: 'PENDING', deadlineAt: { $lte: now } },
      {
        $set: {
          status: 'REJECTED',
          resolvedAt: now,
          onChainDecisionStatus: 'DEAD_LETTER',
          onChainDecisionNextAttemptAt: null,
          onChainDecisionLastError: 'Hồ sơ hết hạn không thể có đủ chữ ký để ghi quyết định on-chain.',
          updatedAt: now
        }
      },
      { returnDocument: 'after' }
    ).lean<DisbursementCommitteeVoteRecord>().exec();
    if (!expiredCase) break;
    await updateDisbursementByRequestIdWithCondition(expiredCase.requestId, { status: 'PENDING' }, { status: 'EXPIRED' });
    await recordAdminAuditLog({
      actorType: 'SYSTEM',
      adminId: null,
      adminRole: null,
      actionType: 'DISBURSEMENT_COMMITTEE_VOTE_REJECT',
      targetId: expiredCase.requestId,
      targetType: 'DISBURSEMENT_REQUEST',
      reason: 'Hồ sơ giải ngân hết hạn biểu quyết 7 ngày theo chính sách fail-closed.',
      context: { requestId: expiredCase.requestId, vote: 'REJECT', outcome: 'EXPIRED' }
    });
    expiredCount += 1;
  }
  return expiredCount;
}

/** Khôi phục DLQ signer hoặc relay sau khi admin đã đối soát, không mở lại bản ghi không đủ chữ ký hợp lệ. */
export async function recoverDeadLetterDisbursementCommitteeExecution(
  requestId: string,
  scope: DisbursementCommitteeRecoveryScope = 'EXECUTION'
): Promise<void> {
  if (scope === 'ON_CHAIN_DECISION') {
    const record = await findDisbursementCommitteeVoteByRequestId(requestId);
    if (record) {
      const winningDecision: DisbursementCommitteeDecision = record.status === 'APPROVED' ? 'APPROVE' : 'REJECT';
      const signatureSelection = selectCommitteeDecisionThresholdSignatures(record.committeeSnapshot, record.votes, winningDecision);
      if (signatureSelection.status !== 'READY') {
        throw new ApplicationError('Hồ sơ không có đủ chữ ký EIP-712 hợp lệ để khôi phục relay on-chain.', 409, 'INVALID_STATUS_TRANSITION');
      }
    }
  }
  if (!await recoverDisbursementCommitteeExecution(requestId, scope)) {
    const statusDescription = scope === 'ON_CHAIN_DECISION'
      ? 'quyết định on-chain đang DEAD_LETTER hoặc NEEDS_RESIGN'
      : 'execution APPROVED đang DEAD_LETTER';
    throw new ApplicationError(`Chỉ có thể khôi phục hồ sơ giải ngân ${statusDescription}.`, 409, 'INVALID_STATUS_TRANSITION');
  }
}

/** Lấy hàng chờ riêng của ủy viên cùng vote case; không dùng API ký tay cũ của admin/regulatory. */
export async function getPendingDisbursementCommitteeCases(
  committeeUserId: string,
  cursor: string | null = null,
  limitCount: number = 20
): Promise<{
  items: Array<{
  committeeCase: DisbursementCommitteeVoteRecord;
  disbursement: Awaited<ReturnType<typeof findDisbursementsByRequestIds>>[number];
  monitoring: Awaited<ReturnType<typeof getExecutiveActiveProjectDetail>>;
  }>;
  nextCursor: string | null;
}> {
  const page = await findPendingDisbursementCommitteeVotes(
    committeeUserId,
    decodePendingDisbursementCursor(cursor),
    limitCount
  );
  const disbursementByRequestId = new Map((await findDisbursementsByRequestIds(page.items.map(item => item.requestId)))
    .map(record => [record.requestId, record]));
  const actionableCases = page.items.flatMap(committeeCase => {
    const disbursement = disbursementByRequestId.get(committeeCase.requestId);
    return disbursement?.status === 'PENDING' ? [{ committeeCase, disbursement }] : [];
  });
  const monitoringByProjectId = await getExecutiveActiveProjectDetails(actionableCases.map(item => item.disbursement.projectId));
  const items = actionableCases.flatMap(item => {
    const monitoring = monitoringByProjectId.get(item.disbursement.projectId);
    return monitoring ? [{ ...item, monitoring }] : [];
  });
  return { items, nextCursor: encodePendingDisbursementCursor(page.nextCursor) };
}
