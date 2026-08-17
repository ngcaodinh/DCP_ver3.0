import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

const mocks = vi.hoisted(() => ({
  listOrganizationFeedback: vi.fn()
}));

vi.mock('../../services/organizationFeedback.service', () => ({
  listOrganizationFeedback: mocks.listOrganizationFeedback
}));

import { handleListOrganizationFeedback } from '../../controllers/organizationFeedbackController';

function createResponse(): { response: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  return {
    response: { status, json } as unknown as Response,
    status,
    json
  };
}

function createRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    query: {},
    authenticatedUser: { userId: 'org-1', role: 'organizations' },
    ...overrides
  } as AuthenticatedRequest;
}

describe('organizationFeedbackController', () => {
  beforeEach(() => {
    mocks.listOrganizationFeedback.mockReset();
  });

  it('trả 400 và không gọi service khi query không hợp lệ', async () => {
    const { response, status, json } = createResponse();

    await handleListOrganizationFeedback(createRequest({ query: { limit: '101' } }), response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'VALIDATION_ERROR' }));
    expect(mocks.listOrganizationFeedback).not.toHaveBeenCalled();
  });

  it('trả 401 khi request không có userId sau middleware auth', async () => {
    const { response, status, json } = createResponse();

    await handleListOrganizationFeedback(
      createRequest({ authenticatedUser: undefined }),
      response
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'UNAUTHENTICATED' }));
  });

  it('parse query, khóa organizationId theo JWT và trả data service', async () => {
    const { response, status, json } = createResponse();
    const serviceResult = {
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      stats: { totalCount: 0, visibleCount: 0, pendingCount: 0, avgRating: null, distribution: {} }
    };
    mocks.listOrganizationFeedback.mockResolvedValueOnce(serviceResult);

    await handleListOrganizationFeedback(createRequest({
      query: { page: '2', source: 'public', moderationState: 'pending' }
    }), response);

    expect(mocks.listOrganizationFeedback).toHaveBeenCalledWith(
      { page: 2, limit: 20, moderationState: 'pending', source: 'public' },
      'org-1'
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: serviceResult }));
  });

  it('trả 500 contract chuẩn khi service lỗi ngoài dự kiến', async () => {
    const { response, status, json } = createResponse();
    mocks.listOrganizationFeedback.mockRejectedValueOnce(new Error('database unavailable'));

    await handleListOrganizationFeedback(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }));
  });
});
