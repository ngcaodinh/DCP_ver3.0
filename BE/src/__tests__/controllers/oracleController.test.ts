/**
 * Unit tests cho oracleController.ts — chủ yếu kiểm tra handleGetOverrideRequestById.
 * [B2-fix #6] Endpoint GET /override-requests/:id bị thiếu trong B2; đây là test cho fix đó.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../models/oracleOverrideRequestModel', () => ({
  findOverrideRequestById: vi.fn(),
  findPendingOverrideRequests: vi.fn(),
  countPendingOverrideRequests: vi.fn()
}));

vi.mock('../../models/projectGeofenceModel', () => ({
  findGeofenceByProjectId: vi.fn(),
  upsertProjectGeofence: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  findProjectById: vi.fn()
}));

vi.mock('../../services/oracleService', () => ({
  verifyEvidenceImage: vi.fn(),
  ORACLE_MAX_FILE_SIZE: 10 * 1024 * 1024
}));

vi.mock('../../services/overrideVotingService', () => ({
  submitOverrideVote: vi.fn(),
  VoteRejectedError: class VoteRejectedError extends Error {
    constructor(public rejectionReason: string) {
      super(rejectionReason);
    }
  }
}));

vi.mock('../../queues/oracleQueue', () => ({
  enqueueOracleVerification: vi.fn()
}));

vi.mock('../../utils/apiResponse', () => ({
  sendSuccessResponse: vi.fn(),
  sendErrorResponse: vi.fn(),
  sendErrorFromUnknown: vi.fn()
}));

import { handleGetOverrideRequestById } from '../../controllers/oracleController';
import { findOverrideRequestById } from '../../models/oracleOverrideRequestModel';
import { sendSuccessResponse, sendErrorResponse } from '../../utils/apiResponse';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMockRequest(overrides: {
  params?: Record<string, string>;
  authenticatedUser?: { userId: string; role: string } | null;
} = {}): AuthenticatedRequest {
  return {
    params: { overrideRequestId: 'req-001', ...overrides.params },
    authenticatedUser: overrides.authenticatedUser !== undefined
      ? overrides.authenticatedUser
      : { userId: 'admin-1', role: 'admin' },
    body: {},
    query: {}
  } as unknown as AuthenticatedRequest;
}

function buildMockResponse(): Response {
  return {} as Response;
}

function buildOverrideRequest(overrides: Record<string, unknown> = {}) {
  return {
    overrideRequestId: 'req-001',
    status: 'PENDING',
    projectId: 'proj-001',
    organizationId: 'org-001',
    commissionerSnapshot: [
      { userId: 'admin-1', role: 'admin' },
      { userId: 'regulatory-1', role: 'regulatory' },
      { userId: 'admin-2', role: 'admin' }
    ],
    votes: [],
    ...overrides
  };
}

// ─── Tests: handleGetOverrideRequestById ─────────────────────────────────────

describe('handleGetOverrideRequestById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[T4] 401 khi chưa đăng nhập', async () => {
    const req = buildMockRequest({ authenticatedUser: null });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 401, expect.any(String), 'UNAUTHENTICATED');
    expect(findOverrideRequestById).not.toHaveBeenCalled();
  });

  it('[T4] 404 khi override request không tồn tại', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(null);
    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 404, expect.any(String), 'NOT_FOUND');
  });

  it('[T4] 200 với pendingVoters và totalVoters đúng (không ai vote)', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(
      res,
      200,
      expect.any(String),
      expect.objectContaining({
        totalVoters: 3,
        pendingVoters: 3,
        hasCurrentUserVoted: false
      })
    );
  });

  it('[T4] hasCurrentUserVoted = true khi user đã vote', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
        ]
      }) as never
    );
    const req = buildMockRequest({ authenticatedUser: { userId: 'admin-1', role: 'admin' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(
      res,
      200,
      expect.any(String),
      expect.objectContaining({
        hasCurrentUserVoted: true,
        pendingVoters: 2,
        totalVoters: 3
      })
    );
  });

  it('[T4] anti-collusion: PENDING chỉ trả vote của chính user, ẩn vote của người khác', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({
        status: 'PENDING',
        votes: [
          { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'confirmed', votedAt: new Date() }
        ]
      }) as never
    );
    // admin-1 xem request — admin-2 đã vote nhưng admin-1 chưa vote
    const req = buildMockRequest({ authenticatedUser: { userId: 'admin-1', role: 'admin' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { votes: unknown[]; hasCurrentUserVoted: boolean };

    // Vote của admin-2 phải bị ẩn khi request còn PENDING (chỉ admin-1 thấy vote của mình)
    expect(responseData.votes).toHaveLength(0);          // admin-1 chưa vote → votes rỗng
    expect(responseData.hasCurrentUserVoted).toBe(false);
  });

  it('[T4] anti-collusion: APPROVED trả đầy đủ votes để audit', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({
        status: 'APPROVED',
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
          { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
          { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
        ]
      }) as never
    );
    const req = buildMockRequest({ authenticatedUser: { userId: 'admin-1', role: 'admin' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { votes: unknown[] };

    // Khi đã APPROVED, trả đủ votes để FE render audit trail
    expect(responseData.votes).toHaveLength(3);
  });

  it('[T4] 400 khi thiếu overrideRequestId param', async () => {
    const req = buildMockRequest({ params: { overrideRequestId: '' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });
});
