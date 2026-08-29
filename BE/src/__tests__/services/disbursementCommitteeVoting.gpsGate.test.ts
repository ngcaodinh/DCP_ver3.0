import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findDisbursementCommitteeVoteByRequestId: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findDisbursementByRequestId: vi.fn(),
  recordAdminAuditLog: vi.fn(),
  getExecutiveActiveProjectDetail: vi.fn()
}));

vi.mock('../../models/authModel', () => ({ findActiveExecutiveCommittee: vi.fn() }));
vi.mock('../../models/disbursementCommitteeVoteModel', () => ({
  DisbursementCommitteeVoteMongoModel: { findOneAndUpdate: mocks.findOneAndUpdate },
  createDisbursementCommitteeVote: vi.fn(),
  findDisbursementCommitteeVoteByRequestId: mocks.findDisbursementCommitteeVoteByRequestId,
  findPendingDisbursementCommitteeVotes: vi.fn()
}));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: mocks.findDisbursementByRequestId,
  findDisbursementsByRequestIds: vi.fn(),
  updateDisbursementByRequestIdWithCondition: vi.fn()
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAdminAuditLog }));
vi.mock('../../services/executiveProjectMonitoring.service', () => ({
  getExecutiveActiveProjectDetail: mocks.getExecutiveActiveProjectDetail
}));

import { voteOnDisbursement } from '../../services/disbursementCommitteeVoting.service';

const REQUEST_ID = 'REQ-GPS-001';
const VOTER_ID = 'member-1';

/** Tạo snapshot pending tối thiểu để cô lập GPS gate khỏi các nhánh resolve case. */
function createPendingCase() {
  return {
    requestId: REQUEST_ID,
    status: 'PENDING',
    deadlineAt: new Date(Date.now() + 60_000),
    votes: [],
    requiredMemberVotes: 2,
    committeeSnapshot: [
      { userId: VOTER_ID, role: 'executive_member' },
      { userId: 'member-2', role: 'executive_member' },
      { userId: 'member-3', role: 'executive_member' },
      { userId: 'member-4', role: 'executive_member' },
      { userId: 'chair-1', role: 'executive_chair' }
    ]
  };
}

/** Mô phỏng chain lean/exec của mongoose, giữ unit test không phụ thuộc Mongo. */
function mongooseResult<T>(value: T) {
  return { lean: () => ({ exec: async () => value }) };
}

describe('voteOnDisbursement GPS acknowledgement gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findDisbursementCommitteeVoteByRequestId.mockResolvedValue(createPendingCase());
    mocks.findDisbursementByRequestId.mockResolvedValue({ requestId: REQUEST_ID, projectId: 'PRJ-1' });
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);
    mocks.findOneAndUpdate.mockImplementation(() => mongooseResult({
      ...createPendingCase(),
      votes: [{ voterUserId: VOTER_ID, voterRole: 'executive_member', decision: 'APPROVE' }]
    }));
  });

  it.each(['DEVIATED', 'CRITICAL'])('từ chối vote %s chưa có xác nhận GPS', async highestDeviationLevel => {
    mocks.getExecutiveActiveProjectDetail.mockResolvedValue({ highestDeviationLevel });

    await expect(voteOnDisbursement(VOTER_ID, {
      requestId: REQUEST_ID,
      decision: 'APPROVE',
      reason: 'Đủ lý do cho một phiếu thử nghiệm.'
    })).rejects.toMatchObject({ statusCode: 400, errorCode: 'VALIDATION_ERROR' });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
  });

  it('cho phép vote GPS rủi ro sau khi xác nhận và lưu dấu vết audit', async () => {
    mocks.getExecutiveActiveProjectDetail.mockResolvedValue({ highestDeviationLevel: 'CRITICAL' });

    await expect(voteOnDisbursement(VOTER_ID, {
      requestId: REQUEST_ID,
      decision: 'APPROVE',
      reason: 'Đã kiểm tra bằng chứng GPS và bản đồ đối chiếu.',
      gpsRiskAcknowledged: true
    })).resolves.toMatchObject({ requestId: REQUEST_ID, status: 'PENDING' });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ gpsRiskAcknowledged: true })
    }));
  });

  it('không yêu cầu xác nhận khi monitoring không phát hiện sai lệch GPS', async () => {
    mocks.getExecutiveActiveProjectDetail.mockResolvedValue({ highestDeviationLevel: 'INSIDE' });

    await expect(voteOnDisbursement(VOTER_ID, {
      requestId: REQUEST_ID,
      decision: 'REJECT',
      reason: 'Không còn phù hợp với mục đích giải ngân đã đăng ký.'
    })).resolves.toMatchObject({ requestId: REQUEST_ID, status: 'PENDING' });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledOnce();
  });
});
