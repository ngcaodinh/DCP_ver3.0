import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resumeAuditorIntent: vi.fn(),
  sendErrorFromUnknown: vi.fn(),
  sendSuccessResponse: vi.fn()
}));

vi.mock('../../services/auditorOnboardingService', () => ({
  executeAuditorStake: vi.fn(),
  getAuditorOnboardingStatus: vi.fn(),
  registerAuditorIntent: vi.fn(),
  resumeAuditorIntent: mocks.resumeAuditorIntent,
  requestAuditorUnstake: vi.fn(),
  updateAuditorPayoutAccountForUser: vi.fn(),
  withdrawAuditorStake: vi.fn()
}));
vi.mock('../../services/auditorPayoutService', () => ({ retryAuditorPayoutBurnAfterManualReview: vi.fn() }));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: vi.fn() }));
vi.mock('../../utils/apiResponse', () => ({
  sendErrorFromUnknown: mocks.sendErrorFromUnknown,
  sendSuccessResponse: mocks.sendSuccessResponse
}));

import { handleResumeAuditorIntent } from '../../controllers/auditorOnboardingController';
import { ApplicationError } from '../../utils/applicationError';

const response = {};
const validRequest = {
  body: { identityToken: 'google-identity-token-123' },
  headers: { 'x-client-ip': '198.51.100.10', 'x-client-user-agent': 'vitest' },
  ip: '127.0.0.1'
};

describe('handleResumeAuditorIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chuyển Google token và metadata sang service, rồi trả đúng response contract', async () => {
    const result = {
      intentId: 'intent-1', minimumStakeThreshold: '3000000', currentTokenBalance: '0', walletAddress: '0xwallet',
      accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token', refreshSessionId: 'session-1',
      expiresAt: new Date('2026-08-25T00:00:00.000Z'), correlationId: 'correlation-1'
    };
    mocks.resumeAuditorIntent.mockResolvedValue(result);

    await handleResumeAuditorIntent(validRequest as never, response as never);

    expect(mocks.resumeAuditorIntent).toHaveBeenCalledWith({
      identityToken: 'google-identity-token-123', ipAddress: '198.51.100.10', userAgent: 'vitest'
    });
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(
      response, 200, expect.any(String), result, 'correlation-1'
    );
  });

  it('từ chối payload không có Google identity token hợp lệ trước khi gọi service', async () => {
    await handleResumeAuditorIntent({ ...validRequest, body: { identityToken: 'short' } } as never, response as never);

    expect(mocks.resumeAuditorIntent).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(
      response,
      expect.objectContaining({ statusCode: 400, errorCode: 'VALIDATION_ERROR' }),
      expect.any(String),
      undefined
    );
  });

  it('ủy quyền lỗi nghiệp vụ của service để API giữ nguyên errorCode', async () => {
    const serviceError = new ApplicationError('Tài khoản đã là Kiểm toán viên.', 409, 'ALREADY_AUDITOR');
    mocks.resumeAuditorIntent.mockRejectedValue(serviceError);

    await handleResumeAuditorIntent(validRequest as never, response as never);

    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(response, serviceError, expect.any(String), undefined);
  });
});
