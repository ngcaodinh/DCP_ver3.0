import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientSession } from 'mongoose';
import {
  ProjectArbitrationMongoModel,
  deadLetterProjectArbitrationOnChainDecision,
  findResolvedProjectArbitrationsNeedingOnChainDecision,
  getProjectArbitrationOnChainDecisionRetryDelayMs,
  markProjectArbitrationDecisionNeedsResign,
  recoverProjectArbitrationOnChainDecision,
  releaseProjectArbitrationOnChainDecision
} from '../../models/projectArbitrationModel';

describe('project arbitration on-chain decision state machine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('khởi tạo recovery counter bằng 0 cho phán quyết mới', () => {
    const arbitration = new ProjectArbitrationMongoModel({});

    expect(arbitration.get('onChainDecisionRecoveryCount')).toBe(0);
    expect(arbitration.get('supersededVoteRounds')).toEqual([]);
  });

  it('tạo backoff xác định, tăng theo attempt và luôn bị chặn bởi ngưỡng tối đa', () => {
    const firstDelay = getProjectArbitrationOnChainDecisionRetryDelayMs('ARB-1', 1);
    const repeatedFirstDelay = getProjectArbitrationOnChainDecisionRetryDelayMs('ARB-1', 1);
    const laterDelay = getProjectArbitrationOnChainDecisionRetryDelayMs('ARB-1', 2);
    const maximumDelay = getProjectArbitrationOnChainDecisionRetryDelayMs('ARB-1', 99);

    expect(repeatedFirstDelay).toBe(firstDelay);
    expect(firstDelay).toBeGreaterThanOrEqual(30_000);
    expect(laterDelay).toBeGreaterThanOrEqual(60_000);
    expect(maximumDelay).toBeLessThanOrEqual(37_500 * 60);
  });

  it('đánh dấu NEEDS_RESIGN bằng compare-and-set và giới hạn nội dung lỗi', async () => {
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(markProjectArbitrationDecisionNeedsResign('ARB-1', 'x'.repeat(600), {
      committeeSnapshot: [{ userId: 'chair-2', role: 'executive_chair', fullName: 'Chủ tịch mới', walletAddress: '0x2' }],
      deadlineAt: new Date('2026-09-05T00:00:00.000Z')
    })).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      { arbitrationId: 'ARB-1', status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
      [expect.objectContaining({
        $set: expect.objectContaining({
          status: 'PENDING',
          verdict: null,
          votes: [],
          onChainDecisionStatus: 'NEEDS_RESIGN',
          onChainDecisionAttemptCount: 0,
          onChainDecisionNextAttemptAt: null,
          onChainDecisionLastError: 'x'.repeat(500),
          supersededVoteRounds: expect.objectContaining({ $concatArrays: expect.any(Array) })
        })
      })]
    );
    const pipeline = updateOne.mock.calls[0][1] as Array<{ $set: Record<string, unknown> }>;
    expect(pipeline[0]?.$set).toMatchObject({
      committeeSnapshot: [{ userId: 'chair-2', role: 'executive_chair', fullName: 'Chủ tịch mới', walletAddress: '0x2' }],
      deadlineAt: new Date('2026-09-05T00:00:00.000Z'),
      resolvedAt: null,
      votes: []
    });
    expect(pipeline[0]?.$set).not.toHaveProperty('projectId');
  });

  it('không báo mở lại vòng ký khi CAS không còn ở RESOLVED/PENDING', async () => {
    vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);

    await expect(markProjectArbitrationDecisionNeedsResign('ARB-LOST-CAS', 'already transitioned', {
      committeeSnapshot: [], deadlineAt: new Date('2026-09-05T00:00:00.000Z')
    })).resolves.toBe(false);
  });

  it('lên lịch retry hữu hạn khi relay lỗi trước ngưỡng DLQ', async () => {
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await releaseProjectArbitrationOnChainDecision('ARB-2', 2, 'RPC unavailable');

    expect(updateOne).toHaveBeenCalledWith(
      { arbitrationId: 'ARB-2', status: 'RESOLVED', onChainDecisionStatus: 'PENDING' },
      expect.objectContaining({
        $set: expect.objectContaining({ onChainDecisionStatus: 'PENDING', onChainDecisionLastError: 'RPC unavailable' }),
        $inc: { onChainDecisionAttemptCount: 1 }
      })
    );
    expect((updateOne.mock.calls[0][1] as { $set: { onChainDecisionNextAttemptAt: Date } }).$set.onChainDecisionNextAttemptAt).toBeInstanceOf(Date);
  });

  it('chuyển relay lỗi lần thứ tám sang DLQ riêng và không lên lịch lại', async () => {
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await releaseProjectArbitrationOnChainDecision('ARB-DLQ', 8, 'SignatureExpired');

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ arbitrationId: 'ARB-DLQ' }),
      expect.objectContaining({
        $set: expect.objectContaining({ onChainDecisionStatus: 'DEAD_LETTER', onChainDecisionNextAttemptAt: null })
      })
    );
  });

  it('cô lập phán quyết không đủ chữ ký để relayer không cảnh báo lặp vô hạn', async () => {
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await deadLetterProjectArbitrationOnChainDecision('ARB-NO-THRESHOLD', 'Không đủ chữ ký.');

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ arbitrationId: 'ARB-NO-THRESHOLD', onChainDecisionStatus: 'PENDING' }),
      expect.objectContaining({ $set: expect.objectContaining({ onChainDecisionStatus: 'DEAD_LETTER', onChainDecisionNextAttemptAt: null }) })
    );
  });

  it('khôi phục duy nhất phán quyết RESOLVED đang DEAD_LETTER về hàng đợi relay sạch', async () => {
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(recoverProjectArbitrationOnChainDecision('ARB-RECOVER')).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        arbitrationId: 'ARB-RECOVER',
        status: 'RESOLVED',
        onChainDecisionStatus: 'DEAD_LETTER'
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          onChainDecisionStatus: 'PENDING',
          onChainDecisionAttemptCount: 0,
          onChainDecisionNextAttemptAt: null,
          onChainDecisionLastError: null
        }),
        $inc: { onChainDecisionRecoveryCount: 1 }
      })
    );
    const updatePayload = updateOne.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(updatePayload.$set).not.toHaveProperty('onChainDecisionTxHash');
    expect(updatePayload.$set).not.toHaveProperty('onChainDecisionRecordedAt');
  });

  it('gan session transaction vao compare-and-set recovery', async () => {
    const session = {} as ClientSession;
    const updateOne = vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(recoverProjectArbitrationOnChainDecision('ARB-RECOVER', session)).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ arbitrationId: 'ARB-RECOVER' }),
      expect.objectContaining({ $inc: { onChainDecisionRecoveryCount: 1 } }),
      { session }
    );
  });

  it('không báo khôi phục thành công khi CAS không khớp DEAD_LETTER, gồm cả NEEDS_RESIGN', async () => {
    vi.spyOn(ProjectArbitrationMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);

    await expect(recoverProjectArbitrationOnChainDecision('ARB-OPEN')).resolves.toBe(false);
  });
  it('chi dua phan quyet co ben thang vao batch relay, ke ca du lieu cu con PENDING', async () => {
    const find = vi.spyOn(ProjectArbitrationMongoModel, 'find')
      .mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) } as never);

    await expect(findResolvedProjectArbitrationsNeedingOnChainDecision(20)).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      status: 'RESOLVED',
      verdict: { $in: ['UPHOLD_PROJECT', 'REJECT_PROJECT'] },
      onChainDecisionStatus: 'PENDING'
    }));
  });
});
