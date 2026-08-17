import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetTrustAdjustedQfRankings, mockFindUserWalletAddressById, mockLoggerInfo } = vi.hoisted(() => ({
  mockGetTrustAdjustedQfRankings: vi.fn(),
  mockFindUserWalletAddressById: vi.fn(),
  mockLoggerInfo: vi.fn()
}));

vi.mock('../../services/qf-ranking.service', () => ({
  getTrustAdjustedQfRankings: mockGetTrustAdjustedQfRankings
}));

vi.mock('../../models/authModel', () => ({
  findUserWalletAddressById: mockFindUserWalletAddressById
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: mockLoggerInfo, error: vi.fn(), warn: vi.fn() }))
}));

import { handleGetTrustAdjustedRankings } from '../../controllers/qfRankingController';

/** Dựng request tối thiểu cho controller test mà không cần khởi động Express app. */
function createRequest(query: Record<string, unknown>, authenticatedUser?: { userId: string; role: string }): Request {
  return { query, authenticatedUser } as unknown as Request;
}

/** Dựng response spy theo contract mà sendSuccessResponse/sendErrorResponse sử dụng. */
function createResponse(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const response = {
    status: vi.fn(),
    json: vi.fn()
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('qfRankingController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserWalletAddressById.mockResolvedValue(null);
  });

  it('tra 400 khi sortBy khong hop le', async () => {
    const response = createResponse();

    await handleGetTrustAdjustedRankings(createRequest({ projectId: 'project-1', sortBy: 'invalid' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'VALIDATION_ERROR' }));
    expect(mockGetTrustAdjustedQfRankings).not.toHaveBeenCalled();
  });

  it('tra 400 khi donorAddress khong phai dia chi EVM hop le', async () => {
    const response = createResponse();

    await handleGetTrustAdjustedRankings(createRequest({ projectId: 'project-1', donorAddress: '0xzzzz' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'VALIDATION_ERROR' }));
    expect(mockGetTrustAdjustedQfRankings).not.toHaveBeenCalled();
  });

  it('tra 400 khi limit vuot qua 50', async () => {
    const response = createResponse();

    await handleGetTrustAdjustedRankings(createRequest({ projectId: 'project-1', limit: '51' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(mockGetTrustAdjustedQfRankings).not.toHaveBeenCalled();
  });

  it('tra 401 khi yeu cau myRanking nhung chua dang nhap', async () => {
    const response = createResponse();

    await handleGetTrustAdjustedRankings(createRequest({
      projectId: 'project-1',
      donorAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    }), response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(mockGetTrustAdjustedQfRankings).not.toHaveBeenCalled();
  });

  it('tra 403 khi donorAddress khong thuoc ve user dang nhap', async () => {
    const response = createResponse();
    mockFindUserWalletAddressById.mockResolvedValueOnce('0x1111111111111111111111111111111111111111');

    await handleGetTrustAdjustedRankings(
      createRequest(
        { projectId: 'project-1', donorAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
        { userId: 'user-1', role: 'donor' }
      ),
      response
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(mockGetTrustAdjustedQfRankings).not.toHaveBeenCalled();
  });

  it('lowercase donorAddress va forward day du query hop le', async () => {
    const response = createResponse();
    mockGetTrustAdjustedQfRankings.mockResolvedValueOnce({ rankings: [], myRanking: null });
    mockFindUserWalletAddressById.mockResolvedValueOnce('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

    await handleGetTrustAdjustedRankings(
      createRequest({
        projectId: 'project-1',
        sortBy: 'original',
        donorAddress: '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd',
        page: '2',
        limit: '10'
      }, { userId: 'user-1', role: 'donor' }),
      response
    );

    expect(mockGetTrustAdjustedQfRankings).toHaveBeenCalledWith({
      projectId: 'project-1',
      roundId: undefined,
      sortBy: 'original',
      donorAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      page: 2,
      limit: 10
    });
    expect(response.status).toHaveBeenCalledWith(200);
    const logPayload = mockLoggerInfo.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(logPayload)).not.toContain('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });
});
