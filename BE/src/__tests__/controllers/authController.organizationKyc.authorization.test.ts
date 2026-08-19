import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetFoundationOrganizationKycSubmissions,
  mockGetPendingOrganizationKycSubmissions,
  mockReviewOrganizationKycSubmission
} = vi.hoisted(() => ({
  mockGetFoundationOrganizationKycSubmissions: vi.fn(),
  mockGetPendingOrganizationKycSubmissions: vi.fn(),
  mockReviewOrganizationKycSubmission: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

vi.mock('../../services/authService', () => ({
  getMyActiveSessions: vi.fn(),
  loginWithGoogle: vi.fn(),
  refreshAccessToken: vi.fn(),
  logFailedGoogleLogin: vi.fn(),
  revokeAllRefreshSessionsForUser: vi.fn()
}));

vi.mock('../../services/organizationKycService', () => ({
  getFoundationOrganizationKycSubmissions: mockGetFoundationOrganizationKycSubmissions,
  getMyOrganizationProfile: vi.fn(),
  getOrganizationKycSubmissionsByUserId: vi.fn(),
  getPendingOrganizationKycSubmissions: mockGetPendingOrganizationKycSubmissions,
  reviewOrganizationKycSubmission: mockReviewOrganizationKycSubmission,
  submitBeneficiaryBankAccount: vi.fn(),
  submitOrganizationKyc: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  findUserById: vi.fn()
}));

import {
  handleGetFoundationOrganizationKycSubmissions,
  handleGetPendingOrganizationKycSubmissions,
  handleReviewOrganizationKycSubmission
} from '../../controllers/authController';

/** Tạo request tối thiểu cho các endpoint review hồ sơ KYC. */
function createRequest(role: string, params: Record<string, string> = {}): Request {
  return {
    authenticatedUser: { userId: `${role}-001`, role },
    params,
    body: { action: 'approve' }
  } as unknown as Request;
}

/** Tạo response Express có thể kiểm tra status và payload trong unit test. */
function createResponse(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Response;
}

describe('organization KYC review authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects admin from reading pending KYC submissions', async () => {
    const response = createResponse();

    await handleGetPendingOrganizationKycSubmissions(createRequest('admin'), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Chỉ cơ quan Regulatory được phép.')
    }));
    expect(mockGetPendingOrganizationKycSubmissions).not.toHaveBeenCalled();
  });

  it('rejects admin from reading foundation KYC history', async () => {
    const response = createResponse();

    await handleGetFoundationOrganizationKycSubmissions(createRequest('admin'), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(mockGetFoundationOrganizationKycSubmissions).not.toHaveBeenCalled();
  });

  it('rejects admin from approving or rejecting KYC submissions', async () => {
    const response = createResponse();

    await handleReviewOrganizationKycSubmission(
      createRequest('admin', { submissionId: 'submission-001' }),
      response
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Chỉ cơ quan Regulatory được phép.')
    }));
    expect(mockReviewOrganizationKycSubmission).not.toHaveBeenCalled();
  });

  it('allows Regulatory to read and review KYC submissions', async () => {
    mockGetPendingOrganizationKycSubmissions.mockResolvedValue([{ submissionId: 'submission-001' }]);
    mockReviewOrganizationKycSubmission.mockResolvedValue({
      submission: { submissionId: 'submission-001' },
      accountUpdate: null
    });

    const pendingResponse = createResponse();
    await handleGetPendingOrganizationKycSubmissions(createRequest('regulatory'), pendingResponse);

    const reviewResponse = createResponse();
    await handleReviewOrganizationKycSubmission(
      createRequest('regulatory', { submissionId: 'submission-001' }),
      reviewResponse
    );

    expect(pendingResponse.status).toHaveBeenCalledWith(200);
    expect(mockGetPendingOrganizationKycSubmissions).toHaveBeenCalledOnce();
    expect(reviewResponse.status).toHaveBeenCalledWith(200);
    expect(mockReviewOrganizationKycSubmission).toHaveBeenCalledWith('regulatory-001', expect.objectContaining({
      submissionId: 'submission-001'
    }));
  });

  it('allows Regulatory to read pending and reviewed foundation submissions', async () => {
    mockGetFoundationOrganizationKycSubmissions.mockResolvedValue([
      { submissionId: 'foundation-approved', status: 'APPROVED' },
      { submissionId: 'foundation-pending', status: 'PENDING_REVIEW' }
    ]);
    const response = createResponse();

    await handleGetFoundationOrganizationKycSubmissions(createRequest('regulatory'), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      submissions: expect.arrayContaining([
        expect.objectContaining({ submissionId: 'foundation-approved', status: 'APPROVED' }),
        expect.objectContaining({ submissionId: 'foundation-pending', status: 'PENDING_REVIEW' })
      ])
    }));
  });
});
