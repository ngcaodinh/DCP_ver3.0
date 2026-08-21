import { describe, expect, it } from 'vitest';
import type { ProjectArbitrationRecord } from '../../models/projectArbitrationModel';
import { evaluateVerdict } from '../../services/projectArbitration.service';

/** Tạo snapshot 1 chủ tịch và 4 ủy viên đúng quy tắc 3/5 độc lập với Mongo. */
function createCase(votes: ProjectArbitrationRecord['votes'] = []): ProjectArbitrationRecord {
  const now = new Date('2026-08-20T00:00:00.000Z');
  return {
    arbitrationId: 'case-1', projectId: 'project-1', round: 1, status: 'PENDING', openedByChallengeId: 'challenge-1',
    openedAt: now, deadlineAt: now, committeeSnapshot: [
      { userId: 'chair', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' },
      ...['member-1', 'member-2', 'member-3', 'member-4'].map(userId => ({ userId, role: 'executive_member' as const, fullName: userId, walletAddress: '0x2' }))
    ],
    requiredMemberVotes: 2, votes, verdict: null, abusiveChallengeUserIds: [], resolvedAt: null, createdAt: now, updatedAt: now
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

  it('returns no consensus only after every snapshot member voted', () => {
    expect(evaluateVerdict(createCase([
      vote('chair', 'executive_chair', 'UPHOLD_PROJECT'), vote('member-1', 'executive_member', 'REJECT_PROJECT'),
      vote('member-2', 'executive_member', 'REJECT_PROJECT'), vote('member-3', 'executive_member', 'UPHOLD_PROJECT'), vote('member-4', 'executive_member', 'REJECT_PROJECT')
    ]))).toBe('NO_CONSENSUS');
  });
});
