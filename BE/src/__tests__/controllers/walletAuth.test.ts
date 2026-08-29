import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildWalletLoginMessage: vi.fn(),
  loginWithWallet: vi.fn(),
  loginWithGoogle: vi.fn(),
  logFailedGoogleLogin: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));
vi.mock('../../services/authService', () => ({
  buildWalletLoginMessage: mocks.buildWalletLoginMessage,
  getMyActiveSessions: vi.fn(),
  loginWithGoogle: mocks.loginWithGoogle,
  loginWithWallet: mocks.loginWithWallet,
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
vi.mock('../../models/authModel', () => ({
  createWalletLoginNonce: vi.fn(),
  findUserById: vi.fn()
}));

import { handleGoogleLogin, handleWalletLogin } from '../../controllers/authController';

const walletAddress = '0x1111111111111111111111111111111111111111';

/** Tạo request Express tối thiểu cho các nhánh đăng nhập ví và Google. */
function createRequest(body: Record<string, unknown>, headers: Record<string, string> = {
  'x-client-ip': '127.0.0.1',
  'x-client-user-agent': 'vitest'
}): Request {
  return { body, headers } as unknown as Request;
}

/** Tạo response Express có spy để kiểm tra status và JSON shape mà controller trả về. */
function createResponse(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Response;
}

/** Tạo kết quả phiên chung để đối chiếu giữa wallet login và Google login. */
function createLoginResult() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    csrfToken: 'csrf-token',
    refreshSessionId: 'refresh-session-id',
    expiresAt: '2026-08-28T00:00:00.000Z',
    user: {
      id: 'executive-1',
      email: 'chair@dcp.local',
      fullName: 'DAO Chair',
      walletAddress,
      role: 'executive_chair',
      accountStatus: 'ACTIVE'
    },
    correlationId: 'correlation-id'
  };
}

describe('wallet auth controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildWalletLoginMessage.mockReturnValue('DCP wallet login message');
  });

  it('trả cùng JWT/session shape như Google login khi wallet login thành công', async () => {
    const loginResult = createLoginResult();
    mocks.loginWithWallet.mockResolvedValue(loginResult);
    mocks.loginWithGoogle.mockResolvedValue(loginResult);
    const walletResponse = createResponse();
    const googleResponse = createResponse();

    await handleWalletLogin(createRequest({ walletAddress, nonce: 'nonce-1', signature: '0xsig' }), walletResponse);
    await handleGoogleLogin(createRequest({ idToken: 'google-token', role: 'donor' }), googleResponse);

    expect(walletResponse.status).toHaveBeenCalledWith(200);
    expect(walletResponse.json).toHaveBeenCalledWith(loginResult);
    expect(googleResponse.status).toHaveBeenCalledWith(200);
    const walletJsonCalls = (walletResponse.json as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const googleJsonCalls = (googleResponse.json as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(walletJsonCalls[0]?.[0]).toEqual(googleJsonCalls[0]?.[0]);
  });

  it.each([
    ['wrong signer', 'Chữ ký không thuộc địa chỉ ví đã khai báo.', 401],
    ['replayed nonce', 'Nonce đăng nhập đã được sử dụng.', 401],
    ['expired nonce', 'Nonce đăng nhập không hợp lệ hoặc đã hết hạn.', 401],
    ['donor wallet', 'Địa chỉ này chưa được cấp quyền quản trị.', 403],
    ['unassigned wallet', 'Địa chỉ này chưa được cấp quyền quản trị.', 403],
    ['suspended seat', 'Tài khoản quản trị không còn hoạt động.', 403]
  ])('map %s thành status và error envelope ổn định', async (_caseName, message, statusCode) => {
    const error = Object.assign(new Error(message), { statusCode });
    mocks.loginWithWallet.mockRejectedValue(error);
    const response = createResponse();

    await handleWalletLogin(createRequest({ walletAddress, nonce: 'nonce-1', signature: '0xsig' }), response);

    expect(response.status).toHaveBeenCalledWith(statusCode);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message,
      errorCode: statusCode === 403 ? 'FORBIDDEN' : 'WALLET_LOGIN_FAILED',
      details: [],
      correlationId: null
    }));
  });

  it('chặn payload wallet sai định dạng trước khi gọi service', async () => {
    const response = createResponse();

    await handleWalletLogin(createRequest({ walletAddress: 'not-an-address', nonce: 'nonce-1', signature: '0xsig' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorCode: 'VALIDATION_ERROR'
    }));
    expect(mocks.loginWithWallet).not.toHaveBeenCalled();
  });
});
