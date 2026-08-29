import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockVerify, mockSendErrorResponse, mockSetRequestUser } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSendErrorResponse: vi.fn(),
  mockSetRequestUser: vi.fn()
}));

vi.mock('jsonwebtoken', () => ({
  default: { verify: mockVerify }
}));

vi.mock('../../config/jsonWebToken', () => ({
  getJsonWebTokenConfig: vi.fn(() => ({ issuer: 'issuer', audience: 'audience' })),
  getJsonWebTokenSecret: vi.fn(() => 'secret')
}));

vi.mock('../../utils/apiResponse', () => ({
  sendErrorResponse: mockSendErrorResponse
}));

vi.mock('../../config/requestContext', () => ({
  setRequestUser: mockSetRequestUser
}));

import { createOptionalAuthenticationMiddleware } from '../../middleware/authenticationMiddleware';

function createRequest(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

function createResponse(): Response {
  return {} as Response;
}

describe('createOptionalAuthenticationMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cho request public đi qua khi không có access token', () => {
    const next = vi.fn() as unknown as NextFunction;

    createOptionalAuthenticationMiddleware()(createRequest(), createResponse(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendErrorResponse).not.toHaveBeenCalled();
  });

  it('từ chối token không hợp lệ thay vì bypass kiểm tra owner', () => {
    mockVerify.mockImplementationOnce(() => {
      throw new Error('invalid token');
    });
    const next = vi.fn() as unknown as NextFunction;

    createOptionalAuthenticationMiddleware()(
      createRequest('Bearer invalid'),
      createResponse(),
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(mockSendErrorResponse).toHaveBeenCalledWith(
      expect.anything(),
      401,
      expect.any(String),
      'UNAUTHENTICATED'
    );
  });

  it('gắn claims đã verify vào request khi token hợp lệ', () => {
    mockVerify.mockReturnValueOnce({ userId: 'user-1', role: 'donor', authVersion: 2 });
    const request = createRequest('Bearer valid');
    const next = vi.fn() as unknown as NextFunction;

    return createOptionalAuthenticationMiddleware()(request, createResponse(), next).then(() => {

    expect(next).toHaveBeenCalledOnce();
    expect((request as Request & { authenticatedUser?: unknown }).authenticatedUser).toEqual({
      userId: 'user-1',
      role: 'donor',
      authVersion: 2
    });
    expect(mockSetRequestUser).toHaveBeenCalledWith('user-1');
    expect(mockSendErrorResponse).not.toHaveBeenCalled();
    });
  });
});
