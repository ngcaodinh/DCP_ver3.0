import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';
import { ApplicationError } from '../../utils/applicationError';

vi.mock('../../services/manualReviewService', () => ({
  getPendingManualReview: vi.fn(),
  getManualReviewDetail: vi.fn(),
  manualApprove: vi.fn(),
  manualReject: vi.fn()
}));

import * as manualReviewService from '../../services/manualReviewService';
import {
  handleGetPendingManualReview,
  handleGetManualReviewDetail,
  handleManualApprove,
  handleManualReject
} from '../../controllers/manualReviewController';

/** Tạo mock request cho controller manual review với shape tối thiểu. */
function createMockRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    authenticatedUser: { userId: 'admin-001', role: 'admin' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

/** Tạo mock response có chain status/json giống Express. */
function createMockResponse(): Response {
  const response: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return response as Response;
}

describe('manualReviewController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated pending-review data with standard envelope', async () => {
    vi.mocked(manualReviewService.getPendingManualReview).mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0
    });

    const response = createMockResponse();
    await handleGetPendingManualReview(createMockRequest({ query: { page: '2', limit: '10' } }), response);

    expect(manualReviewService.getPendingManualReview).toHaveBeenCalledWith({ page: 2, limit: 10 });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ page: 2, limit: 10 })
      })
    );
  });

  it('caps pending-review limit at the server hard limit', async () => {
    const response = createMockResponse();
    await handleGetPendingManualReview(createMockRequest({ query: { limit: '51' } }), response);

    expect(manualReviewService.getPendingManualReview).toHaveBeenCalledWith({ page: 1, limit: 50 });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('returns detail DTO by requestId and preserves route contract', async () => {
    vi.mocked(manualReviewService.getManualReviewDetail).mockResolvedValue({
      queueId: 'MRQ-001',
      requestId: 'DS-001',
      projectId: 'project-001',
      organizationId: 'org-001',
      amount: 1000,
      requestMode: 'NORMAL',
      emergencyReason: null,
      payosTransferStatus: 'MANUAL_REVIEW',
      payosTransferAttemptCount: 3,
      payosTransferLastError: 'failed',
      reviewCycle: 1,
      assignedAdminId: 'admin-001',
      assignmentMethod: 'LEAST_LOADED',
      slaDeadline: new Date('2026-08-04T00:00:00.000Z'),
      escalatedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      nextRetryAt: null,
      beneficiaryBankAccount: {
        bankName: 'VCB',
        bankAccountNumber: '******7890',
        accountHolderName: 'Ng**********'
      },
      transferLogs: [],
      auditLogs: [],
      status: 'APPROVED'
    });

    const response = createMockResponse();
    await handleGetManualReviewDetail(createMockRequest({ params: { id: 'DS-001' } }), response);

    expect(manualReviewService.getManualReviewDetail).toHaveBeenCalledWith('DS-001', {
      revealBankAccount: false,
      adminUserId: 'admin-001'
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ requestId: 'DS-001', queueId: 'MRQ-001' })
      })
    );
  });

  it('returns 401 when manual approve lacks authenticated user', async () => {
    const response = createMockResponse();
    await handleManualApprove(
      createMockRequest({ params: { id: 'DS-001' }, authenticatedUser: undefined }),
      response
    );

    expect(manualReviewService.manualApprove).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: 'UNAUTHORIZED' })
    );
  });

  it('returns 202 when approve is accepted for retry processing', async () => {
    vi.mocked(manualReviewService.manualApprove).mockResolvedValue({
      requestId: 'DS-001',
      queueId: 'MRQ-001',
      reviewCycle: 1,
      status: 'APPROVED',
      payosTransferStatus: 'PROCESSING'
    });

    const response = createMockResponse();
    await handleManualApprove(createMockRequest({ params: { id: 'DS-001' } }), response);

    expect(manualReviewService.manualApprove).toHaveBeenCalledWith('DS-001', 'admin-001');
    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ payosTransferStatus: 'PROCESSING' })
      })
    );
  });

  it('rejects manual reject body shorter than ten characters', async () => {
    const response = createMockResponse();
    await handleManualReject(
      createMockRequest({ params: { id: 'DS-001' }, body: { reason: 'short' } }),
      response
    );

    expect(manualReviewService.manualReject).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: 'VALIDATION_ERROR' })
    );
  });

  it('maps service ApplicationError to standard error envelope', async () => {
    vi.mocked(manualReviewService.manualReject).mockRejectedValue(
      new ApplicationError('PayOS transfer vẫn đang PROCESSING.', 409, 'CONFLICT')
    );

    const response = createMockResponse();
    await handleManualReject(
      createMockRequest({
        params: { id: 'DS-001' },
        body: { reason: 'Provider still processing' }
      }),
      response
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: 'CONFLICT' })
    );
  });
});
