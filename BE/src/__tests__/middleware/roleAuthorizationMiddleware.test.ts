import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

vi.mock('../../models/authModel', () => ({
  findUserById: vi.fn()
}));

import { findUserById } from '../../models/authModel';
import { createFreshRoleAuthorizationMiddleware } from '../../middleware/roleAuthorizationMiddleware';

/** Tạo mock request tối thiểu cho middleware authorization. */
function createRequest(
  overrides: Partial<AuthenticatedRequest> = {}
): AuthenticatedRequest {
  return {
    authenticatedUser: {
      userId: 'admin-001',
      role: 'admin',
      authVersion: 2
    },
    ...overrides
  } as AuthenticatedRequest;
}

/** Tạo mock response cho envelope lỗi chuẩn của Express. */
function createResponse(): Response {
  const response: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return response as Response;
}

describe('createFreshRoleAuthorizationMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows an active admin with the current authVersion', async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: 'admin-001',
      role: 'admin',
      accountStatus: 'ACTIVE',
      authVersion: 2
    } as never);
    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();

    await createFreshRoleAuthorizationMiddleware(['admin'])(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.authenticatedUser?.role).toBe('admin');
    expect(response.status).not.toHaveBeenCalled();
  });

  it('rejects a stale token after authVersion changes', async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: 'admin-001',
      role: 'admin',
      accountStatus: 'ACTIVE',
      authVersion: 3
    } as never);
    const response = createResponse();

    await createFreshRoleAuthorizationMiddleware(['admin'])(createRequest(), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'UNAUTHENTICATED' }));
  });

  it('rejects an inactive user even when the token role is admin', async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: 'admin-001',
      role: 'admin',
      accountStatus: 'INACTIVE_PENDING_KYC',
      authVersion: 2
    } as never);
    const response = createResponse();

    await createFreshRoleAuthorizationMiddleware(['admin'])(createRequest(), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'UNAUTHENTICATED' }));
  });

  it('rejects a Sybil-flagged account from a fresh privileged action', async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: 'admin-001', role: 'admin', accountStatus: 'ACTIVE', authVersion: 2, isSybil: true
    } as never);
    const response = createResponse();

    await createFreshRoleAuthorizationMiddleware(['admin'])(createRequest(), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'FORBIDDEN' }));
  });

  it('returns 503 when current authorization state cannot be read', async () => {
    vi.mocked(findUserById).mockRejectedValue(new Error('database unavailable'));
    const response = createResponse();

    await createFreshRoleAuthorizationMiddleware(['admin'])(createRequest(), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'AUTHORIZATION_UNAVAILABLE' })
    );
  });
});
