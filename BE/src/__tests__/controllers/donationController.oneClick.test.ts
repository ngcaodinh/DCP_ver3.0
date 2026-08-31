import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';
import { ApplicationError } from '../../utils/applicationError';

const mocks = vi.hoisted(() => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  executeOneClickDonation: vi.fn(),
  recordDonationFromTransactionHash: vi.fn()
}));

vi.mock('../../config/logger', () => ({ getLogger: mocks.getLogger }));
vi.mock('../../services/donationService', () => ({
  executeOneClickDonation: mocks.executeOneClickDonation,
  getDonationHistoryByProjectId: vi.fn(),
  getPublicDonationCampaignDetail: vi.fn(),
  getPublicDonationCampaigns: vi.fn(),
  getPublicDonorList: vi.fn(),
  recordDonationFromTransactionHash: mocks.recordDonationFromTransactionHash,
  syncDonationEventsFromBlockchain: vi.fn()
}));
vi.mock('../../services/liveFeedService', () => ({ getPublicLiveFeedTransactionList: vi.fn() }));

import { handleOneClickDonation } from '../../controllers/donationController';

/** Tạo request tối thiểu của endpoint one-click, có thể ghi đè để kiểm tra từng nhánh HTTP. */
function createMockRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    body: {
      projectId: '1787243072147450589',
      amount: 50,
      isAnonymous: false
    },
    headers: { 'x-request-id': 'request-one-click-001' },
    authenticatedUser: { userId: 'user-001', role: 'donor' },
    ...overrides
  } as AuthenticatedRequest;
}

/** Tạo response Express chainable để xác nhận chính xác HTTP status và payload. */
function createMockResponse(): Response {
  const response: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return response as Response;
}

describe('handleOneClickDonation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordDonationFromTransactionHash.mockResolvedValue({ transactionHash: '0xtransactionhash' });
  });

  it('trả 401 kèm correlation ID khi request chưa được xác thực', async () => {
    const response = createMockResponse();

    await handleOneClickDonation(createMockRequest({ authenticatedUser: undefined }), response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorCode: 'UNAUTHENTICATED',
      correlationId: 'request-one-click-001'
    }));
    expect(mocks.executeOneClickDonation).not.toHaveBeenCalled();
  });

  it('gửi donation công khai và trả transaction hash từ service', async () => {
    mocks.executeOneClickDonation.mockResolvedValue({
      transactionHash: '0xtransactionhash',
      projectId: '1787243072147450589',
      amount: 50,
      isAnonymous: false
    });
    const response = createMockResponse();

    await handleOneClickDonation(createMockRequest(), response);

    expect(mocks.executeOneClickDonation).toHaveBeenCalledWith('user-001', '1787243072147450589', 50, false);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      correlationId: 'request-one-click-001',
      data: expect.objectContaining({ transactionHash: '0xtransactionhash', isAnonymous: false })
    }));
    expect(mocks.recordDonationFromTransactionHash).toHaveBeenCalledWith(
      'user-001',
      '1787243072147450589',
      '0xtransactionhash',
      false
    );
  });

  it('giữ nguyên DECRYPTION_ERROR thay vì trả lỗi 500 chung chung', async () => {
    mocks.executeOneClickDonation.mockRejectedValue(new ApplicationError(
      'Không thể khôi phục khóa ký Smart Account.',
      409,
      'DECRYPTION_ERROR'
    ));
    const response = createMockResponse();

    await handleOneClickDonation(createMockRequest(), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorCode: 'DECRYPTION_ERROR',
      correlationId: 'request-one-click-001'
    }));
  });

  it('giữ nguyên TRANSACTION_FAILED từ bundler/paymaster để frontend có thể cho phép thử lại', async () => {
    mocks.executeOneClickDonation.mockRejectedValue(new ApplicationError(
      'Không thể gửi giao dịch one-click donation. Vui lòng thử lại sau.',
      502,
      'TRANSACTION_FAILED'
    ));
    const response = createMockResponse();

    await handleOneClickDonation(createMockRequest(), response);

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorCode: 'TRANSACTION_FAILED',
      correlationId: 'request-one-click-001'
    }));
  });
});
