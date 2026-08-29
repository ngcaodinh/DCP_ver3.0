import { describe, expect, it } from 'vitest';
import type { ProjectArbitrationRecord } from '../../models/projectArbitrationModel';
import { evaluateVerdict } from '../../services/projectArbitration.service';

/** Tạo snapshot 1 chủ tịch và 4 ủy viên để kiểm tra độc lập luật xét xử. */
function createCase(votes: ProjectArbitrationRecord['votes'] = []): ProjectArbitrationRecord {
  const now = new Date('2026-08-20T00:00:00.000Z');
  return {
    arbitrationId: 'case-1', projectId: 'project-1', round: 1, status: 'PENDING', openedByChallengeId: 'challenge-1',
    openedAt: now, deadlineAt: now, committeeSnapshot: [
      { userId: 'chair', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' },
      ...['member-1', 'member-2', 'member-3', 'member-4'].map(userId => ({ userId, role: 'executive_member' as const, fullName: userId, walletAddress: '0x2' }))
    ],
    requiredMemberVotes: 2, votes, supersededVoteRounds: [], verdict: null, abusiveChallengeUserIds: [], resolvedAt: null, createdAt: now, updatedAt: now
  };
}

/** Tạo phiếu ngắn gọn để chỉ kiểm tra luật đồng thuận trong service thuần. */
function vote(voterUserId: string, voterRole: 'executive_chair' | 'executive_member', decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'): ProjectArbitrationRecord['votes'][number] {
  return { voterUserId, voterRole, decision, reason: 'Lý do hợp lệ tối thiểu.', markedAbusive: false, votedAt: new Date() };
}

describe('evaluateVerdict', () => {
  it('requires chair and two members on the same side', () => {
    expect(evaluateVerdict(createCase([vote('chair', 'executive_chair', 'UPHOLD_PROJECT'), vote('member-1', 'executive_member', 'UPHOLD_PROJECT'), vote('member-2', 'executive_member', 'UPHOLD_PROJECT')]))).toBe('UPHOLD_PROJECT');
  });

  it('does not resolve with two members but no chair', () => {
    expect(evaluateVerdict(createCase([vote('member-1', 'executive_member', 'REJECT_PROJECT'), vote('member-2', 'executive_member', 'REJECT_PROJECT')]))).toBeNull();
  });

  it('chỉ hủy khi đúng cả năm ghế snapshot hợp lệ đều chọn hủy', () => {
    expect(evaluateVerdict(createCase([
      vote('chair', 'executive_chair', 'REJECT_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'REJECT_PROJECT'),
      vote('member-4', 'executive_member', 'REJECT_PROJECT')
    ]))).toBe('REJECT_PROJECT');
  });

  it('không hủy với bốn trên năm phiếu hủy mà chờ phiếu cuối để kết thúc không đồng thuận', () => {
    const firstFourReject = [
      vote('chair', 'executive_chair', 'REJECT_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'REJECT_PROJECT')
    ];
    expect(evaluateVerdict(createCase(firstFourReject))).toBeNull();
    expect(evaluateVerdict(createCase([...firstFourReject, vote('member-4', 'executive_member', 'UPHOLD_PROJECT')]))).toBe('NO_CONSENSUS');
  });

  it('không hủy khi snapshot thiếu ghế dù tất cả người trong snapshot chọn hủy', () => {
    const record = createCase([
      vote('chair', 'executive_chair', 'REJECT_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'REJECT_PROJECT')
    ]);
    record.committeeSnapshot = record.committeeSnapshot.slice(0, 4);

    expect(evaluateVerdict(record)).toBe('NO_CONSENSUS');
  });

  it('không hủy khi có phiếu trùng hoặc vai trò phiếu không khớp snapshot 5/5', () => {
    const duplicateVoteRecord = createCase([
      vote('chair', 'executive_chair', 'REJECT_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'REJECT_PROJECT'),
      vote('member-3', 'executive_member', 'REJECT_PROJECT')
    ]);
    const mismatchedRoleRecord = createCase([
      vote('chair', 'executive_chair', 'REJECT_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'REJECT_PROJECT'),
      vote('member-4', 'executive_chair', 'REJECT_PROJECT')
    ]);

    expect(evaluateVerdict(duplicateVoteRecord)).toBe('NO_CONSENSUS');
    expect(evaluateVerdict(mismatchedRoleRecord)).toBe('NO_CONSENSUS');
  });

  it('không suy diễn không đồng thuận khi snapshot trống hoặc chưa đủ phiếu', () => {
    const emptySnapshotRecord = createCase();
    emptySnapshotRecord.committeeSnapshot = [];

    expect(evaluateVerdict(emptySnapshotRecord)).toBeNull();
    expect(evaluateVerdict(createCase([vote('chair', 'executive_chair', 'REJECT_PROJECT')]))).toBeNull();
  });

  it('returns no consensus only after every snapshot member voted', () => {
    expect(evaluateVerdict(createCase([
      vote('chair', 'executive_chair', 'UPHOLD_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'UPHOLD_PROJECT'), vote('member-4', 'executive_member', 'REJECT_PROJECT')
    ]))).toBe('NO_CONSENSUS');
  });
});
