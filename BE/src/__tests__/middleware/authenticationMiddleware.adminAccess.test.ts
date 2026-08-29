import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrimaryAdminLoginWalletAddress } from '../../config/adminAccess';

const ADMIN_LOGIN_WALLET_ADDRESS = getPrimaryAdminLoginWalletAddress();

const { mockFindUserById, mockSendErrorResponse, mockSetRequestUser, mockVerify } = vi.hoisted(() => ({
  mockFindUserById: vi.fn(),
  mockSendErrorResponse: vi.fn(),
  mockSetRequestUser: vi.fn(),
  mockVerify: vi.fn()
}));

vi.mock('jsonwebtoken', () => ({ default: { verify: mockVerify } }));
vi.mock('../../config/jsonWebToken', () => ({
  getJsonWebTokenConfig: vi.fn(() => ({ issuer: 'issuer', audience: 'audience' })),
  getJsonWebTokenSecret: vi.fn(() => 'secret')
}));
vi.mock('../../models/authModel', () => ({ findUserById: mockFindUserById }));
vi.mock('../../utils/apiResponse', () => ({ sendErrorResponse: mockSendErrorResponse }));
vi.mock('../../config/requestContext', () => ({ setRequestUser: mockSetRequestUser }));

import {
  createAuthenticationMiddleware,
  createOptionalAuthenticationMiddleware
} from '../../middleware/authenticationMiddleware';

/** Tạo request bearer tối thiểu cho middleware authorization. */
function createRequest(): Request {
  return { headers: { authorization: 'Bearer valid-token' } } as unknown as Request;
}

describe('createAuthenticationMiddleware admin wallet allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockReturnValue({ userId: 'user-1', role: 'admin', authVersion: 1 });
  });

  it('cho admin allowlist dùng access token còn hiệu lực', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'user-1', role: 'admin', governanceWalletAddress: ADMIN_LOGIN_WALLET_ADDRESS,
      accountStatus: 'ACTIVE', isSybil: false, authVersion: 1
    });
    const next = vi.fn() as unknown as NextFunction;

    await createAuthenticationMiddleware()(createRequest(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockSendErrorResponse).not.toHaveBeenCalled();
  });

  it('từ chối access token admin legacy khi ví DB không còn được ủy quyền', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'user-1', role: 'admin', governanceWalletAddress: '0x1111111111111111111111111111111111111111',
      accountStatus: 'ACTIVE', isSybil: false, authVersion: 1
    });
    const next = vi.fn() as unknown as NextFunction;

    await createAuthenticationMiddleware()(createRequest(), {} as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockSendErrorResponse).toHaveBeenCalledWith(expect.anything(), 401, expect.any(String), 'UNAUTHENTICATED');
  });

  it('từ chối token admin legacy cả trên optional authentication', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'user-1', role: 'admin', governanceWalletAddress: '0x1111111111111111111111111111111111111111',
      accountStatus: 'ACTIVE', isSybil: false, authVersion: 1
    });
    const next = vi.fn() as unknown as NextFunction;

    await createOptionalAuthenticationMiddleware()(createRequest(), {} as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockSendErrorResponse).toHaveBeenCalledWith(expect.anything(), 401, expect.any(String), 'UNAUTHENTICATED');
  });

  it('không áp allowlist admin lên executive role đang active', async () => {
    mockVerify.mockReturnValue({ userId: 'chair-1', role: 'executive_chair', authVersion: 1 });
    mockFindUserById.mockResolvedValue({
      id: 'chair-1', role: 'executive_chair', governanceWalletAddress: '0x1111111111111111111111111111111111111111',
      accountStatus: 'ACTIVE', isSybil: false, authVersion: 1
    });
    const next = vi.fn() as unknown as NextFunction;

    await createAuthenticationMiddleware()(createRequest(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockSendErrorResponse).not.toHaveBeenCalled();
  });
});
