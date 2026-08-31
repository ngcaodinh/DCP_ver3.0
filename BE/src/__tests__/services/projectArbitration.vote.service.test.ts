import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSession } from 'mongoose';
import type { ProjectArbitrationRecord } from '../../models/projectArbitrationModel';

const mocks = vi.hoisted(() => ({
  findArbitrationById: vi.fn(),
  findChallenges: vi.fn(),
  findOneAndUpdate: vi.fn(),
  readCommitteeEpochFromChain: vi.fn(),
  recoverArbitrationOnChainDecision: vi.fn(),
  updateProject: vi.fn(),
  findProject: vi.fn(),
  aggregateDonationSummary: vi.fn(),
  activateApprovedProject: vi.fn(),
  closeRejectedProject: vi.fn(),
  prepareVoteSignature: vi.fn()
}));

vi.mock('../../repositories/projectArbitrationRepository', () => ({
  findProjectArbitrationByIdFromRepository: mocks.findArbitrationById,
  createProjectArbitrationFromRepository: vi.fn()
}));
vi.mock('../../models/projectArbitrationModel', () => ({
  ProjectArbitrationMongoModel: { findOneAndUpdate: mocks.findOneAndUpdate },
  recoverProjectArbitrationOnChainDecision: mocks.recoverArbitrationOnChainDecision
}));
vi.mock('../../models/authModel', () => ({ findActiveExecutiveCommittee: vi.fn() }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mocks.findProject, updateProjectIfStatus: mocks.updateProject }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ findProjectChallengesFromRepository: mocks.findChallenges }));
vi.mock('../../models/donationModel', () => ({ aggregateDonationSummaryByProjectId: mocks.aggregateDonationSummary }));
vi.mock('../../services/projectActivation.service', () => ({ activateApprovedProject: mocks.activateApprovedProject }));
vi.mock('../../services/projectClosure.service', () => ({ closeRejectedProject: mocks.closeRejectedProject }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ releaseAuditorOpenCase: vi.fn() }));
vi.mock('../../services/committeeGovernanceEip712.service', () => ({
  prepareCommitteeVoteSignature: mocks.prepareVoteSignature,
  readCommitteeEpochFromChain: mocks.readCommitteeEpochFromChain,
  verifyCommitteeVoteSignature: vi.fn().mockResolvedValue({
    signature: null,
    signedPayloadHash: null,
    committeeEpoch: null,
    reasonCommitment: null,
    nonce: null,
    deadline: null
  })
}));

import { prepareArbitrationVoteSignature, recoverDeadLetterProjectArbitrationOnChainDecision, resolveArbitrationByTimeout, voteOnArbitration } from '../../services/projectArbitration.service';

/** Tạo vụ xét xử tối thiểu với một Chủ tịch nằm trong snapshot bất biến. */
function createArbitration(overrides: Partial<ProjectArbitrationRecord> = {}): ProjectArbitrationRecord {
  const now = new Date();
  const deadlineAt = new Date(now.getTime() + (60 * 60 * 1000));
  return {
    arbitrationId: 'arbitration-1', projectId: 'project-1', round: 1, status: 'PENDING', openedByChallengeId: 'challenge-1',
    openedAt: now, deadlineAt, committeeSnapshot: [{ userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' }],
    requiredMemberVotes: 0, votes: [], supersededVoteRounds: [], verdict: null, abusiveChallengeUserIds: [], resolvedAt: null, createdAt: now, updatedAt: now,
    ...overrides
  };
}

/** Tạo phán quyết có đủ chữ ký threshold hợp lệ để kiểm thử recovery. */
function createRelayReadyArbitration(
  overrides: Partial<ProjectArbitrationRecord> = {},
  deadline = new Date(Date.now() + (60 * 60 * 1000))
): ProjectArbitrationRecord {
  return createArbitration({
    status: 'RESOLVED',
    verdict: 'UPHOLD_PROJECT',
    onChainDecisionStatus: 'DEAD_LETTER',
    committeeSnapshot: [
      { userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x0000000000000000000000000000000000000001' },
      { userId: 'member-1', role: 'executive_member', fullName: 'Member 1', walletAddress: '0x0000000000000000000000000000000000000002' },
      { userId: 'member-2', role: 'executive_member', fullName: 'Member 2', walletAddress: '0x0000000000000000000000000000000000000003' }
    ],
    votes: [
      { voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Du dieu kien.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-chair', nonce: '1', deadline, committeeEpoch: '7' },
      { voterUserId: 'member-1', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Du dieu kien.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-member-1', nonce: '2', deadline, committeeEpoch: '7' },
      { voterUserId: 'member-2', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Du dieu kien.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-member-2', nonce: '3', deadline, committeeEpoch: '7' }
    ],
    ...overrides
  });
}

/** Tạo query Mongoose mô phỏng nhánh CAS không cập nhật được bản ghi. */
function rejectedAtomicUpdate() {
  return { lean: () => ({ exec: async () => null }) };
}

/** Tạo query Mongoose mô phỏng kết quả cập nhật nguyên tử thành công. */
function successfulAtomicUpdate(record: ProjectArbitrationRecord) {
  return { lean: () => ({ exec: async () => record }) };
}

/** Tạo snapshot 5/5 cùng phiếu nền để kiểm tra các transition không thể đảo của P4/P5. */
function createFullCommitteeArbitration(votes: ProjectArbitrationRecord['votes'] = []): ProjectArbitrationRecord {
  const now = new Date();
  return createArbitration({
    committeeSnapshot: [
      { userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' },
      ...['member-1', 'member-2', 'member-3', 'member-4'].map(userId => ({ userId, role: 'executive_member' as const, fullName: userId, walletAddress: '0x2' }))
    ],
    requiredMemberVotes: 2,
    votes,
    openedAt: now,
    deadlineAt: new Date(now.getTime() + 60 * 60 * 1000)
  });
}

/** Tạo phiếu đã ghi để giữ test tập trung vào transition thay vì chữ ký EIP-712. */
function arbitrationVote(
  voterUserId: string,
  voterRole: 'executive_chair' | 'executive_member',
  decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'
): ProjectArbitrationRecord['votes'][number] {
  return { voterUserId, voterRole, decision, reason: 'Bằng chứng đã được kiểm tra đầy đủ.', markedAbusive: false, votedAt: new Date() };
}

describe('voteOnArbitration - CAS conflict handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findProject.mockResolvedValue({ status: 'DISPUTED' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 0, donationCount: 0 });
    mocks.findChallenges.mockResolvedValue([{ challengeId: 'challenge-1' }]);
    mocks.readCommitteeEpochFromChain.mockResolvedValue('7');
    mocks.recoverArbitrationOnChainDecision.mockResolvedValue(true);
    mocks.closeRejectedProject.mockResolvedValue('CLOSED');
    mocks.prepareVoteSignature.mockResolvedValue({ signingRequestId: 'signing-1' });
  });

  it('trả INVALID_STATUS_TRANSITION khi bản ghi đã bị đóng ngay sau preflight', async () => {
    mocks.findArbitrationById
      .mockResolvedValueOnce(createArbitration())
      .mockResolvedValueOnce(createArbitration({ status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', resolvedAt: new Date() }));
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.'
    })).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    expect(mocks.findArbitrationById).toHaveBeenCalledTimes(2);
  });

  it('không ghi phiếu sau deadline khi hạn qua trong lúc xác minh chữ ký', async () => {
    const current = createArbitration({ deadlineAt: new Date(Date.now() + 60_000) });
    const expired = createArbitration({ deadlineAt: new Date(Date.now() - 1) });
    mocks.findArbitrationById.mockResolvedValueOnce(current).mockResolvedValueOnce(expired);
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.'
    })).rejects.toMatchObject({ errorCode: 'REQUEST_EXPIRED' });

    expect(mocks.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      arbitrationId: 'arbitration-1',
      deadlineAt: { $gt: expect.any(Date) }
    });
  });

  it('từ chối trước khi ký khi hồ sơ thiếu, đã đóng, hết hạn hoặc người bỏ phiếu ngoài snapshot', async () => {
    const expired = createArbitration({ deadlineAt: new Date(Date.now() - 1) });
    const outsideSnapshot = createArbitration({ committeeSnapshot: [] });
    mocks.findArbitrationById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createArbitration({ status: 'RESOLVED', resolvedAt: new Date() }))
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(outsideSnapshot);

    await expect(voteOnArbitration('chair-1', { arbitrationId: 'missing', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.' }))
      .rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    await expect(voteOnArbitration('chair-1', { arbitrationId: 'closed', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.' }))
      .rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    await expect(voteOnArbitration('chair-1', { arbitrationId: 'expired', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.' }))
      .rejects.toMatchObject({ errorCode: 'REQUEST_EXPIRED' });
    await expect(voteOnArbitration('chair-1', { arbitrationId: 'outside', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.' }))
      .rejects.toMatchObject({ errorCode: 'NOT_COMMITTEE_MEMBER' });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('khóa cả preflight chữ ký và ghi phiếu khi challenge gốc của arbitration bị thiếu', async () => {
    const current = createArbitration({ openedByChallengeId: 'challenge-missing' });
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findChallenges.mockResolvedValue([{ challengeId: 'challenge-other' }]);

    await expect(prepareArbitrationVoteSignature('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Không thể ký khi dữ liệu tranh chấp thiếu.'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'ARBITRATION_INTEGRITY_ERROR' });
    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Không thể bỏ phiếu khi dữ liệu tranh chấp thiếu.'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'ARBITRATION_INTEGRITY_ERROR' });

    expect(mocks.prepareVoteSignature).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('trả ALREADY_VOTED khi phiếu cùng người dùng vừa được ghi đồng thời', async () => {
    const concurrentlyVoted = createArbitration({ votes: [{
      voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Phiếu cạnh tranh.', markedAbusive: false, votedAt: new Date()
    }] });
    mocks.findArbitrationById.mockResolvedValueOnce(createArbitration()).mockResolvedValueOnce(concurrentlyVoted);
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.'
    })).rejects.toMatchObject({ errorCode: 'ALREADY_VOTED' });
    expect(mocks.findArbitrationById).toHaveBeenCalledTimes(2);
  });

  it('phân biệt mất hồ sơ và mất quyền snapshot sau khi CAS không ghi được phiếu', async () => {
    mocks.findArbitrationById.mockResolvedValueOnce(createArbitration()).mockResolvedValueOnce(null);
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.'
    })).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });

    mocks.findArbitrationById.mockResolvedValueOnce(createArbitration()).mockResolvedValueOnce(createArbitration({ committeeSnapshot: [] }));
    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Lý do hợp lệ tối thiểu.'
    })).rejects.toMatchObject({ errorCode: 'NOT_COMMITTEE_MEMBER' });
  });

  it('từ chối phiếu hủy ACTIVE có tiền quyên góp khi chưa xác nhận rủi ro khóa tiền', async () => {
    mocks.findArbitrationById.mockResolvedValue(createArbitration());
    mocks.findProject.mockResolvedValue({ status: 'ACTIVE' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 2500000, donationCount: 3 });

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Bằng chứng xác nhận cần hủy dự án.'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'DONATION_LOCK_RISK_NOT_ACKNOWLEDGED' });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('từ chối phiếu hủy DISPUTED có donation INDEXED khi chưa xác nhận rủi ro khóa tiền', async () => {
    mocks.findArbitrationById.mockResolvedValue(createArbitration());
    mocks.findProject.mockResolvedValue({ status: 'DISPUTED' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 2_500_000, donationCount: 3 });

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Bằng chứng xác nhận cần hủy dự án.'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'DONATION_LOCK_RISK_NOT_ACKNOWLEDGED' });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cho phép phiếu hủy ACTIVE có tiền sau khi đã xác nhận rủi ro ở server', async () => {
    const current = createArbitration();
    const updated = createArbitration({ votes: [arbitrationVote('chair-1', 'executive_chair', 'REJECT_PROJECT')] });
    const resolved = createArbitration({ ...updated, status: 'RESOLVED', verdict: 'NO_CONSENSUS', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'ACTIVE' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 2_500_000, donationCount: 3 });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Bằng chứng xác nhận cần hủy dự án.',
      donationLockRiskAcknowledged: true
    })).resolves.toMatchObject({ verdict: 'NO_CONSENSUS' });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('không yêu cầu acknowledgement khi dự án ACTIVE chưa nhận tiền quyên góp', async () => {
    const current = createArbitration();
    const updated = createArbitration({ votes: [arbitrationVote('chair-1', 'executive_chair', 'REJECT_PROJECT')] });
    const resolved = createArbitration({ ...updated, status: 'RESOLVED', verdict: 'NO_CONSENSUS', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'ACTIVE' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 0, donationCount: 0 });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Chưa có tiền để cần xác nhận khóa tiền.'
    })).resolves.toMatchObject({ verdict: 'NO_CONSENSUS' });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('đóng on-chain khi phiếu hủy thứ năm đảo dự án ACTIVE sang REJECTED', async () => {
    const existingRejectVotes = [
      arbitrationVote('chair-1', 'executive_chair', 'REJECT_PROJECT'), arbitrationVote('member-1', 'executive_member', 'REJECT_PROJECT'),
      arbitrationVote('member-2', 'executive_member', 'REJECT_PROJECT'), arbitrationVote('member-3', 'executive_member', 'REJECT_PROJECT')
    ];
    const current = createFullCommitteeArbitration(existingRejectVotes);
    const updated = createFullCommitteeArbitration([...existingRejectVotes, arbitrationVote('member-4', 'executive_member', 'REJECT_PROJECT')]);
    const resolved = createFullCommitteeArbitration([...updated.votes]);
    resolved.status = 'RESOLVED';
    resolved.verdict = 'REJECT_PROJECT';
    resolved.resolvedAt = new Date();
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'ACTIVE' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 0, donationCount: 0 });
    mocks.updateProject.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'REJECTED' });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await expect(voteOnArbitration('member-4', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Đủ năm ghế đồng thuận hủy dự án.'
    })).resolves.toMatchObject({ verdict: 'REJECT_PROJECT' });

    expect(mocks.updateProject).toHaveBeenNthCalledWith(1, 'project-1', 'DISPUTED', expect.objectContaining({ status: 'REJECTED' }), undefined);
    expect(mocks.updateProject).toHaveBeenNthCalledWith(2, 'project-1', 'ACTIVE', expect.objectContaining({ closureState: 'PENDING', closureAttemptCount: 0 }), undefined);
    expect(mocks.closeRejectedProject).toHaveBeenCalledWith('project-1');
  });

  it('chỉ đổi DISPUTED sang REJECTED ở lần hủy 5/5 đầu tiên, không gọi đóng chain', async () => {
    const existingRejectVotes = [
      arbitrationVote('chair-1', 'executive_chair', 'REJECT_PROJECT'), arbitrationVote('member-1', 'executive_member', 'REJECT_PROJECT'),
      arbitrationVote('member-2', 'executive_member', 'REJECT_PROJECT'), arbitrationVote('member-3', 'executive_member', 'REJECT_PROJECT')
    ];
    const current = createFullCommitteeArbitration(existingRejectVotes);
    const updated = createFullCommitteeArbitration([...existingRejectVotes, arbitrationVote('member-4', 'executive_member', 'REJECT_PROJECT')]);
    const resolved = { ...updated, status: 'RESOLVED' as const, verdict: 'REJECT_PROJECT' as const, resolvedAt: new Date() };
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'DISPUTED' });
    mocks.aggregateDonationSummary.mockResolvedValue({ totalAmount: 0, donationCount: 0 });
    mocks.updateProject.mockResolvedValueOnce({ status: 'REJECTED' });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await voteOnArbitration('member-4', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Đủ năm ghế đồng thuận hủy dự án.'
    });

    expect(mocks.updateProject).toHaveBeenCalledTimes(1);
    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', 'DISPUTED', expect.objectContaining({ status: 'REJECTED' }), undefined);
    expect(mocks.closeRejectedProject).not.toHaveBeenCalled();
  });

  it('kích hoạt dự án REJECTED khi vòng đầu kết thúc không đồng thuận', async () => {
    const current = createArbitration({
      committeeSnapshot: [
        { userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' },
        { userId: 'member-1', role: 'executive_member', fullName: 'Member', walletAddress: '0x2' }
      ],
      requiredMemberVotes: 1,
      votes: [arbitrationVote('chair-1', 'executive_chair', 'UPHOLD_PROJECT')]
    });
    const updated = { ...current, votes: [...current.votes, arbitrationVote('member-1', 'executive_member', 'REJECT_PROJECT')] };
    const resolved = { ...updated, status: 'RESOLVED' as const, verdict: 'NO_CONSENSUS' as const, resolvedAt: new Date() };
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'NOT_REQUIRED' });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await voteOnArbitration('member-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Không đủ đồng thuận để hủy dự án.'
    });

    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'REJECTED');
  });

  it('kích hoạt dự án REJECTED khi Chair và hai Member cùng ký uphold', async () => {
    const current = createArbitration({
      committeeSnapshot: [
        { userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' },
        { userId: 'member-1', role: 'executive_member', fullName: 'Member 1', walletAddress: '0x2' },
        { userId: 'member-2', role: 'executive_member', fullName: 'Member 2', walletAddress: '0x3' }
      ],
      requiredMemberVotes: 2,
      votes: [
        arbitrationVote('chair-1', 'executive_chair', 'UPHOLD_PROJECT'),
        arbitrationVote('member-1', 'executive_member', 'UPHOLD_PROJECT')
      ]
    });
    const updated = { ...current, votes: [...current.votes, arbitrationVote('member-2', 'executive_member', 'UPHOLD_PROJECT')] };
    const resolved = { ...updated, status: 'RESOLVED' as const, verdict: 'UPHOLD_PROJECT' as const, resolvedAt: new Date() };
    mocks.findArbitrationById.mockResolvedValue(current);
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'NOT_REQUIRED' });
    mocks.findOneAndUpdate.mockReturnValueOnce(successfulAtomicUpdate(updated)).mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await voteOnArbitration('member-2', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ quorum để giữ lại dự án.'
    });

    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'REJECTED');
  });

  it('không tái kích hoạt dự án khi quy trình đóng on-chain đã bắt đầu', async () => {
    const pending = createArbitration();
    const resolved = createArbitration({ status: 'RESOLVED', verdict: 'TIMEOUT', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(pending);
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'PENDING' });
    mocks.findOneAndUpdate.mockReturnValue(successfulAtomicUpdate(resolved));

    await resolveArbitrationByTimeout('arbitration-1');

    expect(mocks.activateApprovedProject).not.toHaveBeenCalled();
  });

  it('cho phép tạo chữ ký cho snapshot round ký lại đang NEEDS_RESIGN', async () => {
    const reopened = createArbitration({ onChainDecisionStatus: 'NEEDS_RESIGN' });
    mocks.findArbitrationById.mockResolvedValue(reopened);

    await expect(prepareArbitrationVoteSignature('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Ký lại theo roster hiện tại.'
    })).resolves.toEqual({ signingRequestId: 'signing-1' });

    expect(mocks.prepareVoteSignature).toHaveBeenCalledWith('ARBITRATION', 'arbitration-1', 'UPHOLD_PROJECT', 'chair-1', 'Ký lại theo roster hiện tại.', reopened.deadlineAt);
  });

  it('từ chối preflight ký lại khi hết hạn, đã đóng hoặc người ký ngoài snapshot', async () => {
    const expired = createArbitration({ deadlineAt: new Date(Date.now() - 1) });
    const resolved = createArbitration({ status: 'RESOLVED', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValueOnce(expired).mockResolvedValueOnce(resolved).mockResolvedValueOnce(createArbitration());

    await expect(prepareArbitrationVoteSignature('chair-1', { arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Ký lại khi hết hạn.' }))
      .rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    await expect(prepareArbitrationVoteSignature('chair-1', { arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Ký lại khi đã đóng.' }))
      .rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    await expect(prepareArbitrationVoteSignature('outside-user', { arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Ký lại ngoài snapshot.' }))
      .rejects.toMatchObject({ errorCode: 'NOT_COMMITTEE_MEMBER' });

    expect(mocks.prepareVoteSignature).not.toHaveBeenCalled();
  });

  it('xóa cờ quấy rối tập thể legacy khi chốt phán quyết uphold', async () => {
    const voted = createArbitration({ votes: [{
      voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Khiếu nại không có căn cứ.', markedAbusive: true, votedAt: new Date()
    }] });
    const resolved = createArbitration({ ...voted, status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', abusiveChallengeUserIds: ['auditor-1', 'auditor-2'], resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(createArbitration());
    mocks.findOneAndUpdate
      .mockReturnValueOnce(successfulAtomicUpdate(voted))
      .mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.'
    });

    expect(mocks.findChallenges).toHaveBeenCalledWith('project-1', 1);
    expect(mocks.findOneAndUpdate.mock.calls[1][1]).toMatchObject({ $set: { abusiveChallengeUserIds: [] } });
    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'DISPUTED');
  });

  it('khôi phục relay khi phán quyết có đủ chữ ký Chair và hai Member còn hạn', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    mocks.findArbitrationById.mockResolvedValue(createArbitration({
      status: 'RESOLVED',
      verdict: 'UPHOLD_PROJECT',
      onChainDecisionStatus: 'DEAD_LETTER',
      committeeSnapshot: [
        { userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x0000000000000000000000000000000000000001' },
        { userId: 'member-1', role: 'executive_member', fullName: 'Member 1', walletAddress: '0x0000000000000000000000000000000000000002' },
        { userId: 'member-2', role: 'executive_member', fullName: 'Member 2', walletAddress: '0x0000000000000000000000000000000000000003' }
      ],
      votes: [
        { voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Đủ điều kiện.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-chair', nonce: '1', deadline, committeeEpoch: '7' },
        { voterUserId: 'member-1', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Đủ điều kiện.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-member-1', nonce: '2', deadline, committeeEpoch: '7' },
        { voterUserId: 'member-2', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Đủ điều kiện.', markedAbusive: false, votedAt: new Date(), signature: '0xsig-member-2', nonce: '3', deadline, committeeEpoch: '7' }
      ]
    }));

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1')).resolves.toBeUndefined();

    expect(mocks.readCommitteeEpochFromChain).toHaveBeenCalledTimes(1);
    expect(mocks.recoverArbitrationOnChainDecision).toHaveBeenCalledWith('arbitration-1');
  });

  it('từ chối trạng thái không phải DEAD_LETTER trước khi đọc epoch on-chain', async () => {
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration({ onChainDecisionStatus: 'NEEDS_RESIGN' }));

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.readCommitteeEpochFromChain).not.toHaveBeenCalled();
    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('từ chối bản ghi không tồn tại trước khi đọc epoch on-chain', async () => {
    mocks.findArbitrationById.mockResolvedValue(null);

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('missing-arbitration'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.readCommitteeEpochFromChain).not.toHaveBeenCalled();
    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('từ chối khôi phục khi epoch on-chain đã đổi và không đổi trạng thái relay', async () => {
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration());
    mocks.readCommitteeEpochFromChain.mockResolvedValue('8');

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('fail-closed khi không thể đọc epoch on-chain và không đổi trạng thái relay', async () => {
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration());
    mocks.readCommitteeEpochFromChain.mockRejectedValue({ statusCode: 503, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });

    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('từ chối khôi phục relay nếu bộ chữ ký không còn đủ ngưỡng', async () => {
    mocks.findArbitrationById.mockResolvedValue(createArbitration({ status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', onChainDecisionStatus: 'DEAD_LETTER' }));

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('tu choi recovery khi phan quyet khong co ben thang hop le', async () => {
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration({ verdict: 'TIMEOUT' }));

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('tu choi recovery khi chu ky threshold da het han', async () => {
    mocks.findArbitrationById.mockResolvedValue(
      createRelayReadyArbitration({}, new Date(Date.now() - (60 * 1000)))
    );

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverArbitrationOnChainDecision).not.toHaveBeenCalled();
  });

  it('báo conflict khi compare-and-set không còn trạng thái có thể recovery', async () => {
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration());
    mocks.recoverArbitrationOnChainDecision.mockResolvedValue(false);

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });

    expect(mocks.recoverArbitrationOnChainDecision).toHaveBeenCalledWith('arbitration-1');
  });

  it('truyen session transaction vao compare-and-set recovery', async () => {
    const session = {} as ClientSession;
    mocks.findArbitrationById.mockResolvedValue(createRelayReadyArbitration());

    await expect(recoverDeadLetterProjectArbitrationOnChainDecision('arbitration-1', session))
      .resolves.toBeUndefined();

    expect(mocks.recoverArbitrationOnChainDecision).toHaveBeenCalledWith('arbitration-1', session);
  });
  it('danh dau NOT_REQUIRED cho phan quyet khong dong thuan de relayer khong quet vo han', async () => {
    const committeeSnapshot = [
      { userId: 'chair-1', role: 'executive_chair' as const, fullName: 'Chair', walletAddress: '0x1' },
      { userId: 'member-1', role: 'executive_member' as const, fullName: 'Member', walletAddress: '0x2' }
    ];
    const voted = createArbitration({
      committeeSnapshot,
      requiredMemberVotes: 1,
      votes: [{
        voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Giu du an.', markedAbusive: false, votedAt: new Date()
      }]
    });
    const resolved = createArbitration({ ...voted, status: 'RESOLVED', verdict: 'NO_CONSENSUS', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(voted);
    mocks.findOneAndUpdate
      .mockReturnValueOnce(successfulAtomicUpdate({
        ...voted,
        votes: [...voted.votes, {
          voterUserId: 'member-1', voterRole: 'executive_member', decision: 'REJECT_PROJECT', reason: 'Tu choi du an.', markedAbusive: false, votedAt: new Date()
        }]
      }))
      .mockReturnValueOnce(successfulAtomicUpdate(resolved));
    mocks.updateProject.mockResolvedValue(true);

    await voteOnArbitration('member-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Tu choi du an.'
    });

    expect(mocks.findOneAndUpdate.mock.calls[1][1]).toMatchObject({
      $set: expect.objectContaining({ onChainDecisionStatus: 'NOT_REQUIRED', onChainDecisionNextAttemptAt: null })
    });
  });

  it('danh dau NOT_REQUIRED cho phan quyet timeout de relayer khong quet vo han', async () => {
    const pending = createArbitration();
    const resolved = createArbitration({ status: 'RESOLVED', verdict: 'TIMEOUT', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(pending);
    mocks.findOneAndUpdate.mockReturnValue(successfulAtomicUpdate(resolved));
    mocks.updateProject.mockResolvedValue(true);

    await expect(resolveArbitrationByTimeout('arbitration-1')).resolves.toMatchObject({ verdict: 'TIMEOUT' });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ arbitrationId: 'arbitration-1', status: 'PENDING' }),
      expect.objectContaining({
        $set: expect.objectContaining({ onChainDecisionStatus: 'NOT_REQUIRED', onChainDecisionNextAttemptAt: null })
      }),
      expect.objectContaining({ returnDocument: 'after' })
    );
  });

  it('kích hoạt dự án thay vì hủy khi hết hạn xét xử', async () => {
    const pending = createArbitration();
    const resolved = createArbitration({ status: 'RESOLVED', verdict: 'TIMEOUT', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(pending);
    mocks.findOneAndUpdate.mockReturnValue(successfulAtomicUpdate(resolved));
    mocks.findProject.mockResolvedValue({ status: 'DISPUTED' });

    await expect(resolveArbitrationByTimeout('arbitration-1')).resolves.toMatchObject({ verdict: 'TIMEOUT' });

    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'DISPUTED');
  });

  it('giữ dự án REJECTED khi vòng ký lại hết hạn', async () => {
    const reopened = createArbitration({
      supersededVoteRounds: [{
        committeeSnapshot: [],
        votes: [],
        verdict: 'REJECT_PROJECT',
        supersededAt: new Date(),
        reason: 'Epoch Ủy ban đã thay đổi.'
      }]
    });
    const resolved = createArbitration({ ...reopened, status: 'RESOLVED', verdict: 'TIMEOUT', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(reopened);
    mocks.findOneAndUpdate.mockReturnValue(successfulAtomicUpdate(resolved));
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'NOT_REQUIRED' });

    await expect(resolveArbitrationByTimeout('arbitration-1')).resolves.toMatchObject({ verdict: 'TIMEOUT' });

    expect(mocks.activateApprovedProject).not.toHaveBeenCalled();
  });

  it('giữ dự án REJECTED khi vòng ký lại không đồng thuận', async () => {
    const committeeSnapshot = [
      { userId: 'chair-1', role: 'executive_chair' as const, fullName: 'Chair', walletAddress: '0x1' },
      { userId: 'member-1', role: 'executive_member' as const, fullName: 'Member', walletAddress: '0x2' }
    ];
    const reopened = createArbitration({
      committeeSnapshot,
      requiredMemberVotes: 1,
      votes: [{ voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Giữ dự án.', markedAbusive: false, votedAt: new Date() }],
      supersededVoteRounds: [{
        committeeSnapshot: [],
        votes: [],
        verdict: 'REJECT_PROJECT',
        supersededAt: new Date(),
        reason: 'Epoch Ủy ban đã thay đổi.'
      }]
    });
    const voted = {
      ...reopened,
      votes: [...reopened.votes, { voterUserId: 'member-1', voterRole: 'executive_member' as const, decision: 'REJECT_PROJECT' as const, reason: 'Hủy dự án.', markedAbusive: false, votedAt: new Date() }]
    };
    const resolved = createArbitration({ ...voted, status: 'RESOLVED', verdict: 'NO_CONSENSUS', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(reopened);
    mocks.findOneAndUpdate
      .mockReturnValueOnce(successfulAtomicUpdate(voted))
      .mockReturnValueOnce(successfulAtomicUpdate(resolved));
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'NOT_REQUIRED' });

    await expect(voteOnArbitration('member-1', {
      arbitrationId: 'arbitration-1', decision: 'REJECT_PROJECT', reason: 'Hủy dự án.'
    })).resolves.toMatchObject({ verdict: 'NO_CONSENSUS' });

    expect(mocks.activateApprovedProject).not.toHaveBeenCalled();
  });

  it('kích hoạt dự án khi vòng ký lại có phán quyết UPHOLD_PROJECT mới', async () => {
    const reopened = createArbitration({
      supersededVoteRounds: [{
        committeeSnapshot: [],
        votes: [],
        verdict: 'REJECT_PROJECT',
        supersededAt: new Date(),
        reason: 'Epoch Ủy ban đã thay đổi.'
      }]
    });
    const voted = {
      ...reopened,
      votes: [{ voterUserId: 'chair-1', voterRole: 'executive_chair' as const, decision: 'UPHOLD_PROJECT' as const, reason: 'Giữ dự án.', markedAbusive: false, votedAt: new Date() }]
    };
    const resolved = createArbitration({ ...voted, status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(reopened);
    mocks.findOneAndUpdate
      .mockReturnValueOnce(successfulAtomicUpdate(voted))
      .mockReturnValueOnce(successfulAtomicUpdate(resolved));
    mocks.findProject.mockResolvedValue({ status: 'REJECTED', closureState: 'NOT_REQUIRED' });

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Giữ dự án.'
    })).resolves.toMatchObject({ verdict: 'UPHOLD_PROJECT' });

    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'REJECTED');
  });

  it('bỏ qua timeout khi hồ sơ không tồn tại hoặc đã được chốt bởi worker khác', async () => {
    mocks.findArbitrationById.mockResolvedValueOnce(null).mockResolvedValueOnce(createArbitration({ status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', resolvedAt: new Date() }));

    await expect(resolveArbitrationByTimeout('missing-arbitration')).resolves.toBeNull();
    await expect(resolveArbitrationByTimeout('resolved-arbitration')).resolves.toBeNull();

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('không tạo side effect khi CAS timeout thua worker khác', async () => {
    const pending = createArbitration();
    mocks.findArbitrationById.mockResolvedValue(pending);
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(resolveArbitrationByTimeout('arbitration-1')).resolves.toEqual(pending);

    expect(mocks.activateApprovedProject).not.toHaveBeenCalled();
    expect(mocks.closeRejectedProject).not.toHaveBeenCalled();
  });
});
