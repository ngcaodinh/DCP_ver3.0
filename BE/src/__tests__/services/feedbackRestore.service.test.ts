import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAny: vi.fn(),
  restore: vi.fn(),
  recordAudit: vi.fn(),
  invalidateStats: vi.fn()
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  findBeneficiaryFeedbackByIdIncludingDeleted: mocks.findAny,
  restoreBeneficiaryFeedbackById: mocks.restore
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAudit }));
vi.mock('../../services/publicFeedback.service', () => ({ invalidatePublicFeedbackStatsCache: mocks.invalidateStats }));
import { restoreBeneficiaryFeedback } from '../../services/feedbackModeration.service';

const deletedFeedback = {
  feedbackId: 'fb-restore',
  projectId: 'project-1',
  rating: 4,
  comment: 'feedback thật',
  submittedAt: new Date('2026-08-10T03:12:00.000Z'),
  riskScore: 7,
  isFlagged: true,
  source: 'batch' as const,
  deletedAt: new Date('2026-08-14T00:00:00.000Z'),
  deletedByAdminId: 'admin-delete'
};

describe('feedback restore service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAny.mockResolvedValue(deletedFeedback);
    mocks.recordAudit.mockResolvedValue({});
    mocks.restore.mockResolvedValue({ ...deletedFeedback, deletedAt: undefined, deletedByAdminId: undefined });
  });

  it('ghi audit trước $unset, giữ isFlagged=true và invalidate sau commit', async () => {
    const result = await restoreBeneficiaryFeedback({
      feedbackId: 'fb-restore',
      adminId: 'admin-restore',
      adminRole: 'admin',
      reason: 'Khôi phục vì heuristic đánh nhầm'
    });

    expect(result).toMatchObject({ feedbackId: 'fb-restore', projectId: 'project-1', isFlagged: true });
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'FEEDBACK_RESTORE',
      context: expect.objectContaining({
        deletedAt: '2026-08-14T00:00:00.000Z',
        deletedByAdminId: 'admin-delete',
        daysBeforePurge: expect.any(Number)
      })
    }));
    expect(mocks.restore).toHaveBeenCalledWith('fb-restore');
    expect(mocks.invalidateStats).toHaveBeenCalledWith('project-1');
  });

  it('chưa xoá trả 409, đã purge trả 404 và update null trả conflict', async () => {
    mocks.findAny.mockResolvedValueOnce({ ...deletedFeedback, deletedAt: undefined });
    await expect(restoreBeneficiaryFeedback({
      feedbackId: 'fb-restore', adminId: 'admin-1', adminRole: 'admin', reason: 'Feedback chưa bị xoá'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'FEEDBACK_NOT_DELETED' });

    mocks.findAny.mockResolvedValueOnce(null);
    await expect(restoreBeneficiaryFeedback({
      feedbackId: 'fb-restore', adminId: 'admin-1', adminRole: 'admin', reason: 'Feedback đã quá hạn'
    })).rejects.toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND' });

    mocks.restore.mockResolvedValueOnce(null);
    await expect(restoreBeneficiaryFeedback({
      feedbackId: 'fb-restore', adminId: 'admin-1', adminRole: 'admin', reason: 'Có request khác xử lý'
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
  });

  it('từ chối bản ghi hết hạn trước khi worker purge kịp dọn', async () => {
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    mocks.findAny.mockResolvedValueOnce({ ...deletedFeedback, deletedAt: expiredAt });

    await expect(restoreBeneficiaryFeedback({
      feedbackId: 'fb-restore',
      adminId: 'admin-1',
      adminRole: 'admin',
      reason: 'Expired retention window'
    })).rejects.toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND' });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
