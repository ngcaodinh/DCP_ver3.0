import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findLive: vi.fn(),
  findAny: vi.fn(),
  softDelete: vi.fn(),
  recordAudit: vi.fn(),
  invalidateStats: vi.fn(),
  events: [] as string[]
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  findBeneficiaryFeedbackById: mocks.findLive,
  findBeneficiaryFeedbackByIdIncludingDeleted: mocks.findAny,
  softDeleteBeneficiaryFeedbackById: mocks.softDelete
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAudit }));
vi.mock('../../services/publicFeedback.service', () => ({
  invalidatePublicFeedbackStatsCache: mocks.invalidateStats
}));
import { softDeleteBeneficiaryFeedback } from '../../services/feedbackModeration.service';

const liveFeedback = {
  feedbackId: 'fb-1',
  projectId: 'project-1',
  rating: 5,
  comment: 'spam feedback',
  submittedAt: new Date('2026-08-10T03:12:00.000Z'),
  riskScore: 9,
  isFlagged: true,
  source: 'public' as const,
  updatedAt: new Date('2026-08-10T03:12:00.000Z')
};

describe('feedback deletion service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.findLive.mockResolvedValue(liveFeedback);
    mocks.findAny.mockResolvedValue(liveFeedback);
    mocks.recordAudit.mockImplementation(async () => { mocks.events.push('audit'); });
    mocks.softDelete.mockImplementation(async () => {
      mocks.events.push('soft-delete');
      return { ...liveFeedback, deletedAt: new Date(), deletedByAdminId: 'admin-1' };
    });
    mocks.invalidateStats.mockImplementation(() => { mocks.events.push('invalidate'); });
  });

  it('audit trước $set, trả purgeAfter và invalidate cache sau commit', async () => {
    const result = await softDeleteBeneficiaryFeedback({
      feedbackId: 'fb-1',
      adminId: 'admin-1',
      adminRole: 'admin',
      reason: 'Nội dung spam cần xoá',
      requestContext: { ipAddress: '10.0.0.1', userAgent: 'test' }
    });

    expect(result).toMatchObject({ feedbackId: 'fb-1', projectId: 'project-1' });
    expect(result.purgeAfter.getTime() - result.deletedAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'FEEDBACK_DELETE',
      context: expect.objectContaining({ purgeAfter: expect.any(String), reason: 'Nội dung spam cần xoá' })
    }));
    expect(mocks.events).toEqual(['audit', 'soft-delete', 'invalidate']);
  });

  it('không xoá feedback chưa flag hoặc đã xoá và giữ error code phân biệt', async () => {
    mocks.findLive.mockResolvedValueOnce({ ...liveFeedback, isFlagged: false });
    await expect(softDeleteBeneficiaryFeedback({
      feedbackId: 'fb-1', adminId: 'admin-1', adminRole: 'admin', reason: 'Reason hợp lệ'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'FEEDBACK_NOT_FLAGGED' });

    mocks.findLive.mockResolvedValueOnce(null);
    mocks.findAny.mockResolvedValueOnce({ ...liveFeedback, deletedAt: new Date() });
    await expect(softDeleteBeneficiaryFeedback({
      feedbackId: 'fb-1', adminId: 'admin-1', adminRole: 'admin', reason: 'Reason hợp lệ'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'FEEDBACK_ALREADY_DELETED' });
  });

  it('update atomic trả null thì không báo thành công và audit lỗi được propagate', async () => {
    mocks.softDelete.mockResolvedValueOnce(null);
    await expect(softDeleteBeneficiaryFeedback({
      feedbackId: 'fb-1', adminId: 'admin-1', adminRole: 'admin', reason: 'Concurrent delete reason'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });

    mocks.recordAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(softDeleteBeneficiaryFeedback({
      feedbackId: 'fb-1', adminId: 'admin-1', adminRole: 'admin', reason: 'Durable audit reason'
    })).rejects.toThrow('audit unavailable');
    expect(mocks.softDelete).toHaveBeenCalledTimes(1);
  });
});
