import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAuditorStake: vi.fn(),
  resumeAuditorIntent: vi.fn(),
  createRewardPayout: vi.fn(),
  getStakeOverview: vi.fn(),
  sendErrorFromUnknown: vi.fn(),
  sendSuccessResponse: vi.fn()
}));

vi.mock('../../services/auditorOnboardingService', () => ({
  executeAuditorStake: mocks.executeAuditorStake,
  getAuditorOnboardingStatus: vi.fn(),
  registerAuditorIntent: vi.fn(),
  resumeAuditorIntent: mocks.resumeAuditorIntent,
  requestAuditorUnstake: vi.fn(),
  updateAuditorPayoutAccountForUser: vi.fn(),
  withdrawAuditorStake: vi.fn()
}));
vi.mock('../../services/auditorPayoutService', () => ({ cancelAuditorRewardPayoutAfterManualReview: vi.fn(), retryAuditorPayoutBurnAfterManualReview: vi.fn() }));
vi.mock('../../services/auditorPayoutCreationService', () => ({ createAuditorRewardWithdrawalPayout: mocks.createRewardPayout }));
vi.mock('../../services/auditorPortalReadService', () => ({ getAuditorEarnings: vi.fn(), getAuditorStakeOverview: mocks.getStakeOverview }));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: vi.fn() }));
vi.mock('../../utils/apiResponse', () => ({
  sendErrorFromUnknown: mocks.sendErrorFromUnknown,
  sendSuccessResponse: mocks.sendSuccessResponse
}));

import { handleExecuteAuditorStake, handleGetAuditorStakeOverview, handleResumeAuditorIntent, handleWithdrawAuditorReward } from '../../controllers/auditorOnboardingController';
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

describe('handleExecuteAuditorStake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards an explicit additional stake amount as bigint', async () => {
    const result = { status: 'VERIFYING', txHash: '0xadditional-stake' };
    mocks.executeAuditorStake.mockResolvedValue(result);

    await handleExecuteAuditorStake({
      body: { amount: '25000' },
      headers: { 'x-request-id': 'request-1' },
      authenticatedUser: { userId: 'auditor-1', role: 'auditor' }
    } as never, response as never);

    expect(mocks.executeAuditorStake).toHaveBeenCalledWith('auditor-1', 25_000n);
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(response, 202, expect.any(String), result, 'request-1');
  });

  it('rejects a non-positive explicit stake amount before calling the service', async () => {
    await handleExecuteAuditorStake({
      body: { amount: '0' },
      headers: {},
      authenticatedUser: { userId: 'auditor-1', role: 'auditor' }
    } as never, response as never);

    expect(mocks.executeAuditorStake).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(
      response,
      expect.objectContaining({ statusCode: 400, errorCode: 'VALIDATION_ERROR' }),
      expect.any(String),
      undefined
    );
  });

  it('keeps the onboarding shortfall flow when no explicit amount is provided', async () => {
    const result = { status: 'VERIFYING', txHash: '0xonboarding-stake' };
    mocks.executeAuditorStake.mockResolvedValue(result);

    await handleExecuteAuditorStake({
      body: {},
      headers: {},
      authenticatedUser: { userId: 'auditor-1', role: 'donor' }
    } as never, response as never);

    expect(mocks.executeAuditorStake).toHaveBeenCalledWith('auditor-1');
  });
});

describe('handleWithdrawAuditorReward', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-Auditor before creating a reward payout', async () => {
    await handleWithdrawAuditorReward({
      body: { amountVnd: 100_000 },
      headers: {},
      authenticatedUser: { userId: 'donor-1', role: 'donor' }
    } as never, response as never);

    expect(mocks.createRewardPayout).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(
      response,
      expect.objectContaining({ statusCode: 403, errorCode: 'FORBIDDEN' }),
      expect.any(String),
      undefined
    );
  });

  it('allows a suspended Auditor to create their reward payout', async () => {
    mocks.createRewardPayout.mockResolvedValue({ payoutId: 'reward-payout-1' });

    await handleWithdrawAuditorReward({
      body: { amountVnd: 100_000 },
      headers: {},
      authenticatedUser: { userId: 'auditor-1', role: 'auditor', accountStatus: 'SUSPENDED' }
    } as never, response as never);

    expect(mocks.createRewardPayout).toHaveBeenCalledWith({ auditorUserId: 'auditor-1', amountVnd: 100_000 });
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(response, 202, expect.any(String), { payoutId: 'reward-payout-1' }, undefined);
  });

  it('rejects a non-integer reward withdrawal amount before calling the payout service', async () => {
    await handleWithdrawAuditorReward({
      body: { amountVnd: 100.5 },
      headers: {},
      authenticatedUser: { userId: 'auditor-1', role: 'auditor' }
    } as never, response as never);

    expect(mocks.createRewardPayout).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(
      response,
      expect.objectContaining({ statusCode: 400, errorCode: 'VALIDATION_ERROR' }),
      expect.any(String),
      undefined
    );
  });
});

describe('handleGetAuditorStakeOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an unsupported eligibility query before reading the Auditor account', async () => {
    await handleGetAuditorStakeOverview({
      query: { withExitEligibility: 'true' }, headers: {}, authenticatedUser: { userId: 'auditor-1', role: 'auditor' }
    } as never, response as never);

    expect(mocks.getStakeOverview).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(
      response,
      expect.objectContaining({ statusCode: 400, errorCode: 'VALIDATION_ERROR' }),
      expect.any(String),
      undefined
    );
  });

  it('passes the validated lazy eligibility flag to the portal service', async () => {
    mocks.getStakeOverview.mockResolvedValue({ onchain: null, exitEligibility: null });

    await handleGetAuditorStakeOverview({
      query: { withExitEligibility: '1' }, headers: {}, authenticatedUser: { userId: 'auditor-1', role: 'auditor' }
    } as never, response as never);

    expect(mocks.getStakeOverview).toHaveBeenCalledWith('auditor-1', true);
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(response, 200, expect.any(String), expect.any(Object), undefined);
  });
});
