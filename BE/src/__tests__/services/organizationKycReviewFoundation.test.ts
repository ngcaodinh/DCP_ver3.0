import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSubmissionBySubmissionId: vi.fn(),
  updateOrganizationKycSubmissionReview: vi.fn(),
  findUserById: vi.fn(),
  updateUser: vi.fn(),
  addAuditLog: vi.fn(),
  changeUserRole: vi.fn(),
  revokeUserAccess: vi.fn()
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionBySubmissionId: mocks.findSubmissionBySubmissionId,
  updateOrganizationKycSubmissionReview: mocks.updateOrganizationKycSubmissionReview,
  findPendingKycSubmissions: vi.fn(),
  findSubmissionsByOrganizationId: vi.fn(),
  findLatestSubmissionByOrganizationId: vi.fn(),
  getLatestSubmissionVersion: vi.fn(),
  createOrganizationKycSubmission: vi.fn(),
  findExistingBankAccountOwner: vi.fn()
}));
vi.mock('../../models/authModel', () => ({
  findUserById: mocks.findUserById,
  findUserByLegalRegistrationNumber: vi.fn(),
  updateUser: mocks.updateUser,
  addAuditLog: mocks.addAuditLog
}));
vi.mock('../../services/authAdminService', () => ({
  changeUserRole: mocks.changeUserRole,
  revokeUserAccess: mocks.revokeUserAccess
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

import { reviewOrganizationKycSubmission } from '../../services/organizationKycService';

const foundationSubmission = {
  submissionId: 'foundation-submission',
  organizationId: 'FOUNDATION:031234567',
  organizationName: 'Quỹ Nhân Ái',
  legalRegistrationNumber: '031234567',
  officialWebsite: null,
  organizationDescription: 'Mô tả pháp nhân đại diện.',
  organizationCategory: 'FOUNDATION' as const,
  version: 1,
  status: 'PENDING_REVIEW' as const,
  submittedBy: 'PUBLIC_FOUNDATION_FORM',
  submittedAt: new Date(),
  reviewedBy: null,
  reviewedAt: null,
  rejectionReason: null,
  beneficiaryBankAccount: {
    bankName: 'VCB',
    bankAccountNumber: '1234567890',
    accountHolderName: 'QUY NHAN AI',
    branchName: null
  },
  files: []
};

describe('reviewOrganizationKycSubmission - FOUNDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSubmissionBySubmissionId.mockResolvedValue(foundationSubmission);
    mocks.updateOrganizationKycSubmissionReview.mockResolvedValue({ ...foundationSubmission, status: 'APPROVED' });
    mocks.addAuditLog.mockResolvedValue(undefined);
  });

  it('approve chỉ update off-chain, trả accountUpdate null và không đụng user/on-chain', async () => {
    const result = await reviewOrganizationKycSubmission('reviewer-1', {
      submissionId: foundationSubmission.submissionId,
      reviewPayload: { action: 'approve' }
    });

    expect(result.accountUpdate).toBeNull();
    expect(result.submission.status).toBe('APPROVED');
    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.changeUserRole).not.toHaveBeenCalled();
    expect(mocks.revokeUserAccess).not.toHaveBeenCalled();
    expect(mocks.addAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'FOUNDATION_KYC_REVIEW_APPROVE_SUCCESS' }));
  });

  it('reject thiếu lý do thì dừng trước update', async () => {
    await expect(reviewOrganizationKycSubmission('reviewer-1', {
      submissionId: foundationSubmission.submissionId,
      reviewPayload: { action: 'reject', rejectionReason: '   ' }
    })).rejects.toThrow('lý do');
    expect(mocks.updateOrganizationKycSubmissionReview).not.toHaveBeenCalled();
    expect(mocks.findUserById).not.toHaveBeenCalled();
  });

  it('từ chối action runtime không hợp lệ thay vì mặc định thành reject', async () => {
    await expect(reviewOrganizationKycSubmission('reviewer-1', {
      submissionId: foundationSubmission.submissionId,
      reviewPayload: { action: 'archive' as never }
    })).rejects.toThrow('không hợp lệ');
    expect(mocks.updateOrganizationKycSubmissionReview).not.toHaveBeenCalled();
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it('hồ sơ NGO vẫn đi nhánh cũ và cập nhật account', async () => {
    const ngoSubmission = { ...foundationSubmission, organizationCategory: undefined, organizationId: 'ngo-1', status: 'PENDING_REVIEW' as const };
    mocks.findSubmissionBySubmissionId.mockResolvedValue(ngoSubmission);
    mocks.findUserById.mockResolvedValue({
      id: 'ngo-1', role: 'honor', accountStatus: 'ACTIVE', email: 'ngo@example.org', walletAddress: '0x1'
    });
    mocks.updateUser.mockImplementation(async user => user);
    mocks.updateOrganizationKycSubmissionReview.mockResolvedValue({ ...ngoSubmission, status: 'REJECTED' });

    const result = await reviewOrganizationKycSubmission('reviewer-1', {
      submissionId: ngoSubmission.submissionId,
      reviewPayload: { action: 'reject', rejectionReason: 'Thiếu giấy tờ.' }
    });

    expect(result.accountUpdate).not.toBeNull();
    expect(mocks.findUserById).toHaveBeenCalledWith('ngo-1');
    expect(mocks.updateUser).toHaveBeenCalled();
  });
});
