import { describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFeedback: vi.fn(),
  transitionFlag: vi.fn(),
  recordAudit: vi.fn()
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  findBeneficiaryFeedbackById: mocks.findFeedback,
  transitionBeneficiaryFeedbackFlag: mocks.transitionFlag
}));
vi.mock('../../services/audit-log.service', () => ({
  recordAdminAuditLog: mocks.recordAudit
}));

import { moderateBeneficiaryFeedback } from '../../services/feedbackModeration.service';

const feedback = {
  feedbackId: 'feedback-1',
  projectId: 'project-1',
  beneficiaryNameHash: 'hash',
  rating: 1,
  comment: 'spam',
  submittedAt: new Date(),
  riskScore: 9,
  isFlagged: false,
  uploadedByOrganizationId: 'org-1',
  batchContentHash: 'batch-hash',
  createdAt: new Date(),
  updatedAt: new Date()
};

describe('feedbackModeration.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFeedback.mockResolvedValue(feedback);
    mocks.transitionFlag.mockResolvedValue({ ...feedback, isFlagged: true });
    mocks.recordAudit.mockResolvedValue({});
  });

  it('atomic flag và audit cùng trạng thái mới', async () => {
    const result = await moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1',
      adminId: 'admin-1',
      adminRole: 'admin',
      flagged: true,
      reason: 'Spam content confirmed',
      requestContext: { ipAddress: '10.0.0.2', userAgent: 'admin-browser' }
    });

    expect(result.isFlagged).toBe(true);
    expect(mocks.transitionFlag).toHaveBeenNthCalledWith(1, 'feedback-1', false, true);
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'FEEDBACK_FLAG',
      targetType: 'BENEFICIARY_FEEDBACK',
      context: expect.objectContaining({ isFlaggedBefore: false, isFlaggedAfter: true })
    }));
  });

  it('rejects no-op, missing feedback, invalid reason and non-admin role', async () => {
    mocks.findFeedback.mockResolvedValueOnce({ ...feedback, isFlagged: true });
    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1', adminId: 'admin-1', adminRole: 'admin', flagged: true, reason: 'Already flagged'
    })).rejects.toMatchObject({ statusCode: 409 });

    mocks.findFeedback.mockResolvedValueOnce(null);
    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'missing', adminId: 'admin-1', adminRole: 'admin', flagged: true, reason: 'Valid moderation reason'
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1', adminId: 'admin-1', adminRole: 'admin', flagged: true, reason: 'short'
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1', adminId: 'operator-1', adminRole: 'operator', flagged: true, reason: 'Valid moderation reason'
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('returns conflict for atomic lost update and leaves rollback to the Mongo transaction when audit fails', async () => {
    mocks.transitionFlag.mockResolvedValueOnce(null);
    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1', adminId: 'admin-1', adminRole: 'admin', flagged: true, reason: 'Concurrent flag attempt'
    })).rejects.toMatchObject({ statusCode: 409 });

    mocks.transitionFlag.mockResolvedValueOnce({ ...feedback, isFlagged: true });
    mocks.recordAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(moderateBeneficiaryFeedback({
      feedbackId: 'feedback-1', adminId: 'admin-1', adminRole: 'admin', flagged: true, reason: 'Audit must be durable'
    })).rejects.toThrow('audit unavailable');
    expect(mocks.transitionFlag).toHaveBeenCalledTimes(2);
    expect(mocks.transitionFlag).toHaveBeenLastCalledWith('feedback-1', false, true);
  });
});
