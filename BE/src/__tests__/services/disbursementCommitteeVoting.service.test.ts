import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findDisbursementCommitteeVoteByRequestId: vi.fn(),
  findOneAndUpdate: vi.fn(),
  recoverDisbursementCommitteeExecution: vi.fn(),
  findDisbursementByRequestId: vi.fn(),
  findDisbursementsByRequestIds: vi.fn(),
  updateDisbursementByRequestIdWithCondition: vi.fn(),
  recordAdminAuditLog: vi.fn(),
  getExecutiveActiveProjectDetail: vi.fn(),
  getExecutiveActiveProjectDetails: vi.fn(),
  verifyCommitteeVoteSignature: vi.fn(),
  prepareCommitteeVoteSignature: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findActiveExecutiveCommittee: vi.fn() }));
vi.mock('../../models/disbursementCommitteeVoteModel', () => ({
  DisbursementCommitteeVoteMongoModel: { findOneAndUpdate: mocks.findOneAndUpdate },
  createDisbursementCommitteeVote: vi.fn(),
  findDisbursementCommitteeVoteByRequestId: mocks.findDisbursementCommitteeVoteByRequestId,
  findPendingDisbursementCommitteeVotes: vi.fn(),
  recoverDisbursementCommitteeExecution: mocks.recoverDisbursementCommitteeExecution
}));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: mocks.findDisbursementByRequestId,
  findDisbursementsByRequestIds: mocks.findDisbursementsByRequestIds,
  updateDisbursementByRequestIdWithCondition: mocks.updateDisbursementByRequestIdWithCondition
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAdminAuditLog }));
vi.mock('../../services/executiveProjectMonitoring.service', () => ({
  getExecutiveActiveProjectDetail: mocks.getExecutiveActiveProjectDetail,
  getExecutiveActiveProjectDetails: mocks.getExecutiveActiveProjectDetails
}));
vi.mock('../../services/committeeGovernanceEip712.service', () => ({
  verifyCommitteeVoteSignature: mocks.verifyCommitteeVoteSignature,
  prepareCommitteeVoteSignature: mocks.prepareCommitteeVoteSignature
}));

import {
  evaluateDisbursementVerdict,
  expireOverdueDisbursementCommitteeCases,
  recoverDeadLetterDisbursementCommitteeExecution,
  voteOnDisbursement
} from '../../services/disbursementCommitteeVoting.service';

type Vote = { voterUserId?: string; voterRole: 'executive_chair' | 'executive_member'; decision: 'APPROVE' | 'REJECT'; reason?: string; votedAt?: Date; signature?: string | null; signedPayloadHash?: string | null };
type PendingCase = {
  committeeVoteId: string;
  requestId: string;
  status: string;
  committeeSnapshot: Array<{ userId: string; role: 'executive_chair' | 'executive_member' }>;
  requiredMemberVotes: number;
  votes: Vote[];
  openedAt: Date;
  deadlineAt: Date;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

/** Tạo record tối thiểu để kiểm tra ngưỡng quyết định thuần, không phụ thuộc MongoDB. */
function record(votes: Vote[], size = 5) {
  return {
    votes,
    requiredMemberVotes: 2,
    committeeSnapshot: Array.from({ length: size }, (_, index) => ({ userId: String(index) }))
  } as never;
}

/** Tạo query Mongoose giả lập `.lean().exec()` cho nhánh CAS của service. */
function mongooseResult<T>(value: T) {
  return { lean: () => ({ exec: async () => value }) };
}

/** Tạo case giải ngân pending với đủ snapshot 1 Chair và 4 Member. */
function createPendingCase(): PendingCase {
  const now = new Date();
  return {
    committeeVoteId: 'committee-vote-1',
    requestId: 'request-1',
    status: 'PENDING',
    committeeSnapshot: [
      { userId: 'chair-1', role: 'executive_chair' },
      { userId: 'member-1', role: 'executive_member' },
      { userId: 'member-2', role: 'executive_member' },
      { userId: 'member-3', role: 'executive_member' },
      { userId: 'member-4', role: 'executive_member' }
    ],
    requiredMemberVotes: 2,
    votes: [],
    openedAt: now,
    deadlineAt: new Date(now.getTime() + 60_000),
    resolvedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

/** Ghi phiếu giả lập theo đúng thao tác `$push` mà service gửi tới MongoDB. */
function configureAtomicVoteUpdates(): { getCurrentCase: () => PendingCase } {
  let currentCase = createPendingCase();
  mocks.findDisbursementCommitteeVoteByRequestId.mockImplementation(async () => currentCase);
  mocks.findOneAndUpdate.mockImplementation((_filter: unknown, update: { $push?: { votes: Vote }; $set?: { status?: string } }) => {
    if (update.$push?.votes) currentCase = { ...currentCase, votes: [...currentCase.votes, update.$push.votes] };
    if (update.$set?.status) currentCase = { ...currentCase, status: update.$set.status };
    return mongooseResult(currentCase);
  });
  return { getCurrentCase: () => currentCase };
}

describe('evaluateDisbursementVerdict', () => {
  it('chỉ phê duyệt khi Chair và hai Member cùng phía', () => {
    expect(evaluateDisbursementVerdict(record([
      { voterRole: 'executive_chair', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' }
    ]))).toBe('APPROVED');
  });

  it('không cho bốn Member thay chữ ký Chair', () => {
    expect(evaluateDisbursementVerdict(record([
      { voterRole: 'executive_member', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' }
    ]))).toBeNull();
  });

  it('fail-closed sau khi toàn bộ snapshot đã bỏ phiếu nhưng không có phía đạt ngưỡng', () => {
    expect(evaluateDisbursementVerdict(record([
      { voterRole: 'executive_chair', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'APPROVE' },
      { voterRole: 'executive_member', decision: 'REJECT' },
      { voterRole: 'executive_member', decision: 'REJECT' },
      { voterRole: 'executive_member', decision: 'REJECT' }
    ]))).toBe('REJECTED');
  });
});

describe('voteOnDisbursement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureAtomicVoteUpdates();
    mocks.findDisbursementByRequestId.mockResolvedValue({ requestId: 'request-1', projectId: 'project-1' });
    mocks.getExecutiveActiveProjectDetail.mockResolvedValue({ highestDeviationLevel: 'INSIDE' });
    mocks.verifyCommitteeVoteSignature.mockResolvedValue({
      signature: null,
      signedPayloadHash: null,
      reasonCommitment: null,
      nonce: null,
      deadline: null
    });
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);
  });

  it('không đạt khi bốn Ủy viên đồng ý nhưng thiếu chữ ký Chủ tịch', async () => {
    for (const voterId of ['member-1', 'member-2', 'member-3', 'member-4']) {
      await expect(voteOnDisbursement(voterId, {
        requestId: 'request-1',
        decision: 'APPROVE',
        reason: 'Bằng chứng giải ngân phù hợp.'
      })).resolves.toMatchObject({ status: 'PENDING' });
    }

    expect(mocks.recordAdminAuditLog).toHaveBeenCalledTimes(4);
  });

  it('chốt APPROVED khi Chủ tịch và hai Ủy viên cùng đồng ý', async () => {
    await voteOnDisbursement('chair-1', {
      requestId: 'request-1', decision: 'APPROVE', reason: 'Chủ tịch xác nhận hồ sơ.'
    });
    await voteOnDisbursement('member-1', {
      requestId: 'request-1', decision: 'APPROVE', reason: 'Ủy viên xác nhận hồ sơ.'
    });
    const result = await voteOnDisbursement('member-2', {
      requestId: 'request-1', decision: 'APPROVE', reason: 'Ủy viên thứ hai xác nhận.'
    });

    expect(result.status).toBe('APPROVED');
    expect(mocks.updateDisbursementByRequestIdWithCondition).not.toHaveBeenCalled();
  });

  it('trả 409 khi cùng một người bỏ phiếu lần hai, kể cả khi CAS không cập nhật được', async () => {
    const currentCase = createPendingCase();
    currentCase.votes = [{
      voterUserId: 'member-1', voterRole: 'executive_member', decision: 'APPROVE', reason: 'Phiếu trước đó.', votedAt: new Date(), signature: null, signedPayloadHash: null
    }];
    mocks.findDisbursementCommitteeVoteByRequestId.mockResolvedValue(currentCase);
    mocks.findOneAndUpdate.mockReturnValue(mongooseResult(null));

    await expect(voteOnDisbursement('member-1', {
      requestId: 'request-1', decision: 'APPROVE', reason: 'Lý do hợp lệ cho phiếu lặp.'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'ALREADY_VOTED' });
    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
  });

  it('trả 403 khi người bỏ phiếu không nằm trong snapshot case', async () => {
    await expect(voteOnDisbursement('outsider-1', {
      requestId: 'request-1', decision: 'APPROVE', reason: 'Lý do hợp lệ của người ngoài.'
    })).rejects.toMatchObject({ statusCode: 403, errorCode: 'NOT_COMMITTEE_MEMBER' });
    expect(mocks.findDisbursementByRequestId).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('recoverDeadLetterDisbursementCommitteeExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hoàn tất khi model CAS đã đưa đúng approved case từ DLQ về PENDING', async () => {
    mocks.recoverDisbursementCommitteeExecution.mockResolvedValue(true);

    await expect(recoverDeadLetterDisbursementCommitteeExecution('request-dlq')).resolves.toBeUndefined();

    expect(mocks.recoverDisbursementCommitteeExecution).toHaveBeenCalledWith('request-dlq', 'EXECUTION');
  });

  it('trả conflict khi case không còn là approved DEAD_LETTER để admin không reset state tùy ý', async () => {
    mocks.recoverDisbursementCommitteeExecution.mockResolvedValue(false);

    await expect(recoverDeadLetterDisbursementCommitteeExecution('request-open'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });
  });

  it('từ chối khôi phục relay khi hồ sơ không có đủ chữ ký hợp lệ cùng phía', async () => {
    const validUntil = new Date(Date.now() + 60_000);
    mocks.findDisbursementCommitteeVoteByRequestId.mockResolvedValue({
      requestId: 'request-no-threshold',
      status: 'REJECTED',
      committeeSnapshot: [
        { userId: 'chair', role: 'executive_chair', walletAddress: '0x1111111111111111111111111111111111111111' },
        { userId: 'member-1', role: 'executive_member', walletAddress: '0x2222222222222222222222222222222222222222' },
        { userId: 'member-2', role: 'executive_member', walletAddress: '0x3333333333333333333333333333333333333333' }
      ],
      votes: [
        { voterUserId: 'chair', decision: 'REJECT', signature: '0xsig-chair', nonce: '1', deadline: validUntil, committeeEpoch: '7' },
        { voterUserId: 'member-1', decision: 'REJECT', signature: '0xsig-member-1', nonce: '2', deadline: validUntil, committeeEpoch: '7' }
      ]
    });

    await expect(recoverDeadLetterDisbursementCommitteeExecution('request-no-threshold', 'ON_CHAIN_DECISION'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverDisbursementCommitteeExecution).not.toHaveBeenCalled();
  });

  it('cho phép khôi phục relay khi Chair và hai Member có chữ ký hợp lệ cùng phía', async () => {
    const validUntil = new Date(Date.now() + 60_000);
    mocks.findDisbursementCommitteeVoteByRequestId.mockResolvedValue({
      requestId: 'request-ready',
      status: 'APPROVED',
      committeeSnapshot: [
        { userId: 'chair', role: 'executive_chair', walletAddress: '0x1111111111111111111111111111111111111111' },
        { userId: 'member-1', role: 'executive_member', walletAddress: '0x2222222222222222222222222222222222222222' },
        { userId: 'member-2', role: 'executive_member', walletAddress: '0x3333333333333333333333333333333333333333' }
      ],
      votes: [
        { voterUserId: 'chair', decision: 'APPROVE', signature: '0xsig-chair', nonce: '1', deadline: validUntil, committeeEpoch: '7' },
        { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xsig-member-1', nonce: '2', deadline: validUntil, committeeEpoch: '7' },
        { voterUserId: 'member-2', decision: 'APPROVE', signature: '0xsig-member-2', nonce: '3', deadline: validUntil, committeeEpoch: '7' }
      ]
    });
    mocks.recoverDisbursementCommitteeExecution.mockResolvedValue(true);

    await expect(recoverDeadLetterDisbursementCommitteeExecution('request-ready', 'ON_CHAIN_DECISION')).resolves.toBeUndefined();

    expect(mocks.recoverDisbursementCommitteeExecution).toHaveBeenCalledWith('request-ready', 'ON_CHAIN_DECISION');
  });
});

describe('expireOverdueDisbursementCommitteeCases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('đưa case hết hạn trực tiếp vào DLQ relay vì không thể có đủ chữ ký cùng phía', async () => {
    mocks.findOneAndUpdate.mockReturnValue(mongooseResult(null));

    await expect(expireOverdueDisbursementCommitteeCases(1)).resolves.toBe(0);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING', deadlineAt: { $lte: expect.any(Date) } }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'REJECTED',
          onChainDecisionStatus: 'DEAD_LETTER',
          onChainDecisionNextAttemptAt: null
        })
      }),
      { returnDocument: 'after' }
    );
  });

  it('xử lý đúng một case khi giới hạn đầu vào không hợp lệ, đồng bộ disbursement và ghi audit', async () => {
    mocks.findOneAndUpdate.mockReturnValue(mongooseResult({ requestId: 'request-expired' }));
    mocks.updateDisbursementByRequestIdWithCondition.mockResolvedValue(undefined);
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);

    await expect(expireOverdueDisbursementCommitteeCases(0)).resolves.toBe(1);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(mocks.updateDisbursementByRequestIdWithCondition).toHaveBeenCalledWith(
      'request-expired',
      { status: 'PENDING' },
      { status: 'EXPIRED' }
    );
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'request-expired',
      context: expect.objectContaining({ outcome: 'EXPIRED' })
    }));
  });
});
