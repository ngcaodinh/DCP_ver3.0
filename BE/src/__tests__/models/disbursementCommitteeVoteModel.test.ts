import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DisbursementCommitteeVoteMongoModel,
  claimApprovedDisbursementCommitteeVote,
  deadLetterDisbursementCommitteeOnChainDecision,
  findApprovedDisbursementCommitteeVotes,
  getDisbursementCommitteeOnChainDecisionRetryDelayMs,
  markDisbursementCommitteeDecisionNeedsResign,
  recoverDisbursementCommitteeExecution,
  releaseDisbursementCommitteeOnChainDecision,
  releaseDisbursementCommitteeExecution
} from '../../models/disbursementCommitteeVoteModel';

/** Tạo chain Mongoose tối thiểu để kiểm tra filter queue mà không cần kết nối Mongo thật. */
function createFindChain<T>(value: T): { sort: () => { limit: () => { lean: () => { exec: () => Promise<T> } } } } {
  return {
    sort: () => ({
      limit: () => ({
        lean: () => ({ exec: async () => value })
      })
    })
  };
}

describe('disbursement committee execution queue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chuyển case lỗi lần thứ tám sang DEAD_LETTER và không lên lịch retry nữa', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await releaseDisbursementCommitteeExecution('REQ-DLQ', 'lease-1', 8, 'RPC unavailable');

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'REQ-DLQ', executionStatus: 'PROCESSING', executionLeaseId: 'lease-1' }),
      expect.objectContaining({ $set: expect.objectContaining({ executionStatus: 'DEAD_LETTER', executionNextAttemptAt: null }) })
    );
  });

  it('không tìm hoặc claim lại case DEAD_LETTER trong queue signer', async () => {
    const find = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'find').mockReturnValue(createFindChain([]) as never);
    const findOneAndUpdate = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'findOneAndUpdate')
      .mockReturnValue({ lean: () => ({ exec: async () => null }) } as never);

    await findApprovedDisbursementCommitteeVotes(20, true);
    await claimApprovedDisbursementCommitteeVote('REQ-DLQ', 'lease-1', new Date(Date.now() + 60_000), true);

    expect(JSON.stringify(find.mock.calls[0][0])).not.toContain('DEAD_LETTER');
    expect(JSON.stringify(findOneAndUpdate.mock.calls[0][0])).not.toContain('DEAD_LETTER');
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({ onChainDecisionStatus: 'RECORDED' }));
  });

  it('đưa on-chain relay lỗi lần thứ tám vào DLQ riêng thay vì retry vô hạn', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await releaseDisbursementCommitteeOnChainDecision('REQ-RELAY-DLQ', 8, 'SignatureExpired');

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'REQ-RELAY-DLQ', onChainDecisionStatus: 'PENDING' }),
      expect.objectContaining({ $set: expect.objectContaining({ onChainDecisionStatus: 'DEAD_LETTER', onChainDecisionNextAttemptAt: null }) })
    );
  });

  it('cô lập ngay relay không thể có đủ chữ ký để hàng đợi không lặp vô hạn', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await deadLetterDisbursementCommitteeOnChainDecision('REQ-NO-THRESHOLD', 'Không đủ chữ ký.');

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'REQ-NO-THRESHOLD', onChainDecisionStatus: 'PENDING' }),
      expect.objectContaining({ $set: expect.objectContaining({ onChainDecisionStatus: 'DEAD_LETTER', onChainDecisionNextAttemptAt: null }) })
    );
  });

  it('khôi phục DLQ signer bằng CAS về PENDING và xóa retry state cũ', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(recoverDisbursementCommitteeExecution('REQ-RECOVER')).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      { requestId: 'REQ-RECOVER', status: 'APPROVED', executionStatus: 'DEAD_LETTER' },
      expect.objectContaining({ $set: expect.objectContaining({ executionStatus: 'PENDING', executionAttemptCount: 0, executionLastError: null }) })
    );
  });

  it('khôi phục DLQ relay bằng CAS về PENDING và xóa retry state on-chain cũ', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(recoverDisbursementCommitteeExecution('REQ-RELAY-RECOVER', 'ON_CHAIN_DECISION')).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        requestId: 'REQ-RELAY-RECOVER',
        status: { $in: ['APPROVED', 'REJECTED'] },
        onChainDecisionStatus: { $in: ['DEAD_LETTER', 'NEEDS_RESIGN'] }
      },
      expect.objectContaining({ $set: expect.objectContaining({ onChainDecisionStatus: 'PENDING', onChainDecisionAttemptCount: 0, onChainDecisionLastError: null }) })
    );
  });

  it('mở lại approval cần ký lại, lưu bằng chứng round cũ và thay snapshot cùng deadline mới', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);
    const deadlineAt = new Date('2026-09-05T00:00:00.000Z');
    const committeeSnapshot = [{
      userId: 'new-chair', role: 'executive_chair' as const, fullName: 'Chủ tịch mới',
      walletAddress: '0x1111111111111111111111111111111111111111', governanceWalletAddress: null
    }];

    await expect(markDisbursementCommitteeDecisionNeedsResign('REQ-RESIGN', 'x'.repeat(600), { committeeSnapshot, deadlineAt })).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledOnce();
    expect(updateOne).toHaveBeenCalledWith(
      { requestId: 'REQ-RESIGN', status: 'APPROVED', onChainDecisionStatus: 'PENDING' },
      [expect.objectContaining({
        $set: expect.objectContaining({
          status: 'PENDING', committeeSnapshot, deadlineAt, votes: [], resolvedAt: null,
          onChainDecisionStatus: 'NEEDS_RESIGN', executionStatus: 'WAITING_ON_CHAIN_DECISION',
          onChainDecisionAttemptCount: 0,
          onChainDecisionLastError: 'x'.repeat(500),
          supersededVoteRounds: expect.objectContaining({ $concatArrays: expect.any(Array) })
        })
      })]
    );
  });

  it('không đảo kết quả REJECTED khi cần ký lại, chỉ cô lập relay state để audit', async () => {
    const updateOne = vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValueOnce({ exec: async () => ({ modifiedCount: 0 }) } as never)
      .mockReturnValueOnce({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(markDisbursementCommitteeDecisionNeedsResign('REQ-REJECTED', 'contract epoch changed', {
      committeeSnapshot: [], deadlineAt: new Date('2026-09-05T00:00:00.000Z')
    })).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenLastCalledWith(
      { requestId: 'REQ-REJECTED', status: 'REJECTED', onChainDecisionStatus: 'PENDING' },
      expect.objectContaining({ $set: expect.objectContaining({ onChainDecisionStatus: 'NEEDS_RESIGN' }) })
    );
  });

  it('không báo mở lại khi không transition nào thắng compare-and-set', async () => {
    vi.spyOn(DisbursementCommitteeVoteMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);

    await expect(markDisbursementCommitteeDecisionNeedsResign('REQ-LOST-CAS', 'already transitioned', {
      committeeSnapshot: [], deadlineAt: new Date('2026-09-05T00:00:00.000Z')
    })).resolves.toBe(false);
  });

  it('tạo retry delay xác định, tăng theo attempt và bị giới hạn ở ngưỡng backoff tối đa', () => {
    const firstDelay = getDisbursementCommitteeOnChainDecisionRetryDelayMs('REQ-1', 1);
    const laterDelay = getDisbursementCommitteeOnChainDecisionRetryDelayMs('REQ-1', 2);
    const cappedDelay = getDisbursementCommitteeOnChainDecisionRetryDelayMs('REQ-1', 100);

    expect(getDisbursementCommitteeOnChainDecisionRetryDelayMs('REQ-1', 1)).toBe(firstDelay);
    expect(laterDelay).toBeGreaterThanOrEqual(60_000);
    expect(cappedDelay).toBeLessThanOrEqual(37_500 * 60);
  });
});
