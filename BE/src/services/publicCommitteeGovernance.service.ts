import { isAddress } from 'ethers';
import { DisbursementCommitteeVoteMongoModel, type DisbursementCommitteeVoteRecord } from '../models/disbursementCommitteeVoteModel';
import { ProjectArbitrationMongoModel, type ProjectArbitrationRecord } from '../models/projectArbitrationModel';
import { findPublicCommitteeGovernanceEvents, type PublicCommitteeGovernanceEventRecord } from '../models/publicCommitteeGovernanceEventModel';

export interface PublicCommitteeDecision {
  requestId: string;
  decisionKind: 'DISBURSEMENT' | 'ARBITRATION';
  approved: boolean;
  onChainDecisionTxHash: string | null;
  recordedAt: Date;
  votes: Array<{
    voterName: string;
    voterRole: string;
    decision: string;
    votedAt: Date;
    signature: string | null;
    signedPayloadHash: string | null;
    reasonCommitment: string | null;
    nonce: string | null;
    deadline: Date | null;
    committeeEpoch: string | null;
  }>;
  supersededVoteRounds: Array<{
    verdict: string | null;
    supersededAt: Date;
    reason: string;
    votes: Array<{
      voterName: string;
      voterRole: string;
      decision: string;
      votedAt: Date;
    }>;
  }>;
}

type PublicCommitteeDecisionKind = PublicCommitteeDecision['decisionKind'];
type PublicCommitteeDecisionCursor = {
  recordedAt: Date;
  committeeVoteId: string;
  decisionKind: PublicCommitteeDecisionKind;
};

/** Xác định thứ tự nguồn cố định để cursor không bỏ sót bản ghi trùng thời điểm và mã định danh. */
function getPublicDecisionKindRank(decisionKind: PublicCommitteeDecisionKind): number {
  return decisionKind === 'DISBURSEMENT' ? 1 : 0;
}

/** Tạo điều kiện seek pagination xuyên hai read model theo thời điểm, mã bản ghi và loại quyết định. */
function buildPublicDecisionCursorFilter(
  cursor: PublicCommitteeDecisionCursor,
  recordIdField: 'committeeVoteId' | 'arbitrationId',
  decisionKind: PublicCommitteeDecisionKind
): { $or: Array<Record<string, unknown>> } {
  const sameRecordIdIsAfterCursor = getPublicDecisionKindRank(decisionKind) < getPublicDecisionKindRank(cursor.decisionKind);
  return {
    $or: [
      { onChainDecisionRecordedAt: { $lt: cursor.recordedAt } },
      { onChainDecisionRecordedAt: cursor.recordedAt, [recordIdField]: { $lt: cursor.committeeVoteId } },
      ...(sameRecordIdIsAfterCursor ? [{ onChainDecisionRecordedAt: cursor.recordedAt, [recordIdField]: cursor.committeeVoteId }] : [])
    ]
  };
}

/** Ánh xạ phiếu verified sang dữ liệu công khai, tuyệt đối không đưa free-text lý do của ủy viên ra ngoài. */
function mapPublicVotes(
  committeeSnapshot: Array<{ userId: string; fullName: string }>,
  votes: Array<{ voterUserId: string; voterRole: string; decision: string; votedAt: Date; signature?: string | null; signedPayloadHash?: string | null; reasonCommitment?: string | null; nonce?: string | null; deadline?: Date | null; committeeEpoch?: string | null }>
): PublicCommitteeDecision['votes'] {
  const snapshotByUserId = new Map(committeeSnapshot.map(member => [member.userId, member]));
  return votes.map(vote => ({
    voterName: snapshotByUserId.get(vote.voterUserId)?.fullName || 'Thành viên Ủy ban',
    voterRole: vote.voterRole,
    decision: vote.decision,
    votedAt: vote.votedAt,
    signature: vote.signature || null,
    signedPayloadHash: vote.signedPayloadHash || null,
    reasonCommitment: vote.reasonCommitment || null,
    nonce: vote.nonce || null,
    deadline: vote.deadline || null,
    committeeEpoch: vote.committeeEpoch || null
  }));
}

/** Đọc read model event quản trị theo cursor, không dùng RPC trên request công khai. */
export async function getPublicCommitteeGovernanceEvents(
  cursor: { blockNumber: number; logIndex: number } | null,
  limitCount: number
): Promise<{ items: PublicCommitteeGovernanceEventRecord[]; nextCursor: { blockNumber: number; logIndex: number } | null }> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  if (!isAddress(contractAddress)) return { items: [], nextCursor: null };
  return findPublicCommitteeGovernanceEvents(contractAddress, cursor, limitCount);
}

/** Đọc quyết định đã ghi chain cùng bundle chữ ký server-verified, không công khai free-text nội bộ của ủy viên. */
export async function getPublicCommitteeDecisions(
  cursor: PublicCommitteeDecisionCursor | null,
  limitCount: number
): Promise<{ items: PublicCommitteeDecision[]; nextCursor: PublicCommitteeDecisionCursor | null }> {
  const normalizedLimit = Number.isFinite(limitCount) ? Math.max(1, Math.min(50, Math.floor(limitCount))) : 20;
  const [records, arbitrations] = await Promise.all([
    DisbursementCommitteeVoteMongoModel.find({
      status: { $in: ['APPROVED', 'REJECTED'] },
      onChainDecisionStatus: 'RECORDED',
      onChainDecisionRecordedAt: { $ne: null },
      ...(cursor ? buildPublicDecisionCursorFilter(cursor, 'committeeVoteId', 'DISBURSEMENT') : {})
    })
      .select('committeeVoteId requestId status onChainDecisionTxHash onChainDecisionRecordedAt committeeSnapshot votes')
      .sort({ onChainDecisionRecordedAt: -1, committeeVoteId: -1 })
      .limit(normalizedLimit + 1)
      .lean<DisbursementCommitteeVoteRecord[]>()
      .exec(),
    ProjectArbitrationMongoModel.find({
      status: 'RESOLVED',
      verdict: { $in: ['UPHOLD_PROJECT', 'REJECT_PROJECT'] },
      onChainDecisionStatus: 'RECORDED',
      onChainDecisionRecordedAt: { $ne: null },
      ...(cursor ? buildPublicDecisionCursorFilter(cursor, 'arbitrationId', 'ARBITRATION') : {})
    })
      .select('arbitrationId verdict onChainDecisionTxHash onChainDecisionRecordedAt committeeSnapshot votes supersededVoteRounds')
      .sort({ onChainDecisionRecordedAt: -1, arbitrationId: -1 })
      .limit(normalizedLimit + 1)
      .lean<ProjectArbitrationRecord[]>()
      .exec()
  ]);
  const mappedDisbursements = records.map(record => ({
    recordId: record.committeeVoteId,
    recordedAt: record.onChainDecisionRecordedAt as Date,
    item: {
      requestId: record.requestId,
      decisionKind: 'DISBURSEMENT' as const,
      approved: record.status === 'APPROVED',
      onChainDecisionTxHash: record.onChainDecisionTxHash,
      recordedAt: record.onChainDecisionRecordedAt as Date,
      votes: mapPublicVotes(record.committeeSnapshot, record.votes),
      supersededVoteRounds: []
    } satisfies PublicCommitteeDecision
  }));
  const mappedArbitrations = arbitrations.map(record => ({
    recordId: record.arbitrationId,
    recordedAt: record.onChainDecisionRecordedAt as Date,
    item: {
      requestId: record.arbitrationId,
      decisionKind: 'ARBITRATION' as const,
      approved: record.verdict === 'UPHOLD_PROJECT',
      onChainDecisionTxHash: record.onChainDecisionTxHash || null,
      recordedAt: record.onChainDecisionRecordedAt as Date,
      votes: mapPublicVotes(record.committeeSnapshot, record.votes),
      supersededVoteRounds: (record.supersededVoteRounds || []).map(round => ({
        verdict: round.verdict,
        supersededAt: round.supersededAt,
        reason: round.reason,
        votes: mapPublicVotes(round.committeeSnapshot, round.votes).map(vote => ({
          voterName: vote.voterName, voterRole: vote.voterRole, decision: vote.decision, votedAt: vote.votedAt
        }))
      }))
    } satisfies PublicCommitteeDecision
  }));
  const combinedRecords = [...mappedDisbursements, ...mappedArbitrations]
    .sort((left, right) => (
      right.recordedAt.getTime() - left.recordedAt.getTime()
      || right.recordId.localeCompare(left.recordId)
      || getPublicDecisionKindRank(right.item.decisionKind) - getPublicDecisionKindRank(left.item.decisionKind)
    ));
  const pageRecords = combinedRecords.slice(0, normalizedLimit);
  const lastRecord = pageRecords[pageRecords.length - 1];
  return {
    items: pageRecords.map(record => record.item),
    nextCursor: combinedRecords.length > normalizedLimit && lastRecord
      ? { recordedAt: lastRecord.recordedAt, committeeVoteId: lastRecord.recordId, decisionKind: lastRecord.item.decisionKind }
      : null
  };
}
