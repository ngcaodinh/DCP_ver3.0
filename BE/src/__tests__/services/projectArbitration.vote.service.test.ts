import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArbitrationRecord } from '../../models/projectArbitrationModel';

const mocks = vi.hoisted(() => ({
  findArbitrationById: vi.fn(),
  findChallenges: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateProject: vi.fn(),
  activateApprovedProject: vi.fn()
}));

vi.mock('../../repositories/projectArbitrationRepository', () => ({
  findProjectArbitrationByIdFromRepository: mocks.findArbitrationById,
  createProjectArbitrationFromRepository: vi.fn()
}));
vi.mock('../../models/projectArbitrationModel', () => ({
  ProjectArbitrationMongoModel: { findOneAndUpdate: mocks.findOneAndUpdate }
}));
vi.mock('../../models/authModel', () => ({ findActiveExecutiveCommittee: vi.fn() }));
vi.mock('../../repositories/projectRepository', () => ({ updateProject: mocks.updateProject }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ findProjectChallengesFromRepository: mocks.findChallenges }));
vi.mock('../../services/projectActivation.service', () => ({ activateApprovedProject: mocks.activateApprovedProject }));

import { voteOnArbitration } from '../../services/projectArbitration.service';

/** Tạo vụ xét xử tối thiểu với một Chủ tịch nằm trong snapshot bất biến. */
function createArbitration(overrides: Partial<ProjectArbitrationRecord> = {}): ProjectArbitrationRecord {
  const now = new Date('2026-08-20T00:00:00.000Z');
  return {
    arbitrationId: 'arbitration-1', projectId: 'project-1', round: 1, status: 'PENDING', openedByChallengeId: 'challenge-1',
    openedAt: now, deadlineAt: now, committeeSnapshot: [{ userId: 'chair-1', role: 'executive_chair', fullName: 'Chair', walletAddress: '0x1' }],
    requiredMemberVotes: 0, votes: [], verdict: null, abusiveChallengeUserIds: [], resolvedAt: null, createdAt: now, updatedAt: now,
    ...overrides
  };
}

/** Tạo query Mongoose mô phỏng nhánh CAS không cập nhật được bản ghi. */
function rejectedAtomicUpdate() {
  return { lean: () => ({ exec: async () => null }) };
}

/** Tạo query Mongoose mô phỏng kết quả cập nhật nguyên tử thành công. */
function successfulAtomicUpdate(record: ProjectArbitrationRecord) {
  return { lean: () => ({ exec: async () => record }) };
}

describe('voteOnArbitration - CAS conflict handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trả INVALID_STATUS_TRANSITION khi bản ghi đã bị đóng ngay sau preflight', async () => {
    mocks.findArbitrationById
      .mockResolvedValueOnce(createArbitration())
      .mockResolvedValueOnce(createArbitration({ status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', resolvedAt: new Date() }));
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.', markedAbusive: false
    })).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    expect(mocks.findArbitrationById).toHaveBeenCalledTimes(2);
  });

  it('trả ALREADY_VOTED khi phiếu cùng người dùng vừa được ghi đồng thời', async () => {
    const concurrentlyVoted = createArbitration({ votes: [{
      voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Phiếu cạnh tranh.', markedAbusive: false, votedAt: new Date()
    }] });
    mocks.findArbitrationById.mockResolvedValueOnce(createArbitration()).mockResolvedValueOnce(concurrentlyVoted);
    mocks.findOneAndUpdate.mockReturnValue(rejectedAtomicUpdate());

    await expect(voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.', markedAbusive: false
    })).rejects.toMatchObject({ errorCode: 'ALREADY_VOTED' });
    expect(mocks.findArbitrationById).toHaveBeenCalledTimes(2);
  });

  it('ghi các Auditor của vụ việc vào abusiveChallengeUserIds khi phán quyết uphold có cờ quấy rối', async () => {
    const voted = createArbitration({ votes: [{
      voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Khiếu nại không có căn cứ.', markedAbusive: true, votedAt: new Date()
    }] });
    const resolved = createArbitration({ ...voted, status: 'RESOLVED', verdict: 'UPHOLD_PROJECT', abusiveChallengeUserIds: ['auditor-1', 'auditor-2'], resolvedAt: new Date() });
    mocks.findArbitrationById.mockResolvedValue(createArbitration());
    mocks.findOneAndUpdate
      .mockReturnValueOnce(successfulAtomicUpdate(voted))
      .mockReturnValueOnce(successfulAtomicUpdate(resolved));

    await voteOnArbitration('chair-1', {
      arbitrationId: 'arbitration-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ bằng chứng để giữ dự án.', markedAbusive: true
    });

    expect(mocks.findChallenges).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate.mock.calls[1][1]).toMatchObject({ $set: { abusiveChallengeUserIds: [] } });
    expect(mocks.activateApprovedProject).toHaveBeenCalledWith('project-1', 'DISPUTED');
  });
});
