import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  logFailedGoogleLogin: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));
vi.mock('../../services/authService', () => ({
  getMyActiveSessions: vi.fn(),
  loginWithGoogle: mocks.loginWithGoogle,
  loginWithWallet: vi.fn(),
  buildWalletLoginMessage: vi.fn(),
  refreshAccessToken: vi.fn(),
  logFailedGoogleLogin: mocks.logFailedGoogleLogin,
  revokeAllRefreshSessionsForUser: vi.fn()
}));
vi.mock('../../services/organizationKycService', () => ({
  getFoundationOrganizationKycSubmissions: vi.fn(),
  getMyOrganizationProfile: vi.fn(),
  getOrganizationKycSubmissionsByUserId: vi.fn(),
  getPendingOrganizationKycSubmissions: vi.fn(),
  reviewOrganizationKycSubmission: vi.fn(),
  submitBeneficiaryBankAccount: vi.fn(),
  submitOrganizationKyc: vi.fn()
}));
vi.mock('../../models/authModel', () => ({ findUserById: vi.fn(), createWalletLoginNonce: vi.fn() }));

import { handleGoogleLogin } from '../../controllers/authController';

/** Tạo request Google hợp lệ để tập trung kiểm tra guard role từ service. */
function createRequest(): Request {
  return {
    body: { idToken: 'google-id-token', role: 'donor' },
    headers: { 'x-client-ip': '127.0.0.1', 'x-client-user-agent': 'vitest' }
  } as unknown as Request;
}

/** Tạo response Express giả lập cho assertion status và JSON payload. */
function createResponse(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

/** Tạo phiên Google thành công với role lấy từ nguồn dữ liệu server. */
function createLoginResult(role: string) {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    csrfToken: 'csrf-token',
    refreshSessionId: 'session-1',
    expiresAt: '2026-08-28T00:00:00.000Z',
    user: { id: 'user-1', email: 'user@dcp.local', fullName: 'DCP User', walletAddress: null, role, accountStatus: 'ACTIVE' },
    correlationId: 'correlation-id'
  };
}

describe('Google login governance guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['admin', 'executive_chair', 'executive_member'])('trả 403 cho tài khoản %s dù client gửi role donor', async (role) => {
    mocks.loginWithGoogle.mockRejectedValue(Object.assign(new Error('governance account'), { statusCode: 403 }));
    const response = createResponse();

    await handleGoogleLogin(createRequest(), response);

    expect(mocks.loginWithGoogle).toHaveBeenCalledWith('google-id-token', 'donor', '127.0.0.1', 'vitest');
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Tài khoản quản trị đăng nhập tại cổng riêng bằng ví MetaMask.'
    }));
    expect(mocks.logFailedGoogleLogin).toHaveBeenCalled();
    void role;
  });

  it.each(['donor', 'organization', 'auditor'])('cho phép tài khoản %s tiếp tục flow Google hợp lệ', async (role) => {
    mocks.loginWithGoogle.mockResolvedValue(createLoginResult(role));
    const response = createResponse();

    await handleGoogleLogin(createRequest(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ role }) }));
  });
});
