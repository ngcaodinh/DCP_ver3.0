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
  countPendingOverrideRequests: vi.fn(),
  findCommissionerInSnapshot: vi.fn()
}));

vi.mock('../../models/projectGeofenceModel', () => ({
  findGeofenceByProjectId: vi.fn(),
  upsertProjectGeofence: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  findProjectById: vi.fn(),
  findProjectsByIdList: vi.fn()
}));

// [B3] Controller detail endpoint đọc geofenceSnapshot bất biến qua findVerificationById.
// Mock để test không chạm MongoDB thật (tránh treo timeout).
vi.mock('../../models/oracleVerificationResultModel', () => ({
  findVerificationById: vi.fn()
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

import {
  handleGetGeofence,
  handleGetOverrideRequestById,
  handleGetPendingOverrides,
  handleUpsertGeofence,
  handleVerifyImage,
  handleVerifyImageBatch
} from '../../controllers/oracleController';
import { findOverrideRequestById, findPendingOverrideRequests, findCommissionerInSnapshot } from '../../models/oracleOverrideRequestModel';
import { sendSuccessResponse, sendErrorResponse } from '../../utils/apiResponse';
import { findProjectById, findProjectsByIdList } from '../../repositories/projectRepository';
import { findVerificationById } from '../../models/oracleVerificationResultModel';
import { verifyEvidenceImage } from '../../services/oracleService';
import { enqueueOracleVerification } from '../../queues/oracleQueue';
import { findGeofenceByProjectId, upsertProjectGeofence } from '../../models/projectGeofenceModel';

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

function buildProjectRecord(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj-001',
    name: 'Dự án kiểm thử',
    organizationId: 'org-001',
    description: '',
    goalAmount: 0,
    deadline: new Date(),
    status: 'ACTIVE',
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

describe('handleVerifyImage — evidenceCid validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[B3-security] 400 khi evidenceCid không đúng định dạng IPFS CID', async () => {
    const req = {
      body: { projectId: 'proj-001', evidenceCid: 'https://gateway.pinata.cloud/ipfs/QmBad' },
      file: { buffer: Buffer.from('image'), size: 12, originalname: 'proof.jpg' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    } as unknown as AuthenticatedRequest;
    const res = buildMockResponse();

    await handleVerifyImage(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
    expect(findProjectById).not.toHaveBeenCalled();
    expect(verifyEvidenceImage).not.toHaveBeenCalled();
  });

  it('[B3-security] trim CID hợp lệ trước khi gọi oracle service', async () => {
    const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord() as never);
    vi.mocked(verifyEvidenceImage).mockResolvedValue({
      isValid: true,
      distance: 12,
      reason: null,
      verificationId: 'verif-001',
      overrideRequestId: null
    });
    const req = {
      body: { projectId: 'proj-001', evidenceCid: `  ${validCid}  ` },
      file: { buffer: Buffer.from('image'), size: 12, originalname: 'proof.jpg' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' },
      validatedFile: { isValid: true }
    } as unknown as AuthenticatedRequest;
    const res = buildMockResponse();

    await handleVerifyImage(req, res);

    expect(verifyEvidenceImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'proj-001',
      'org-001',
      validCid
    );
    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), expect.objectContaining({
      verificationId: 'verif-001'
    }));
  });
});

describe('handleVerifyImageBatch — evidenceCid validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[B3-security] 400 khi batch evidenceCids chứa CID không hợp lệ', async () => {
    const req = {
      body: { projectId: 'proj-001', evidenceCids: JSON.stringify(['not-a-cid']) },
      files: [{ size: 12, originalname: 'proof.jpg' }],
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    } as unknown as AuthenticatedRequest;
    const res = buildMockResponse();

    await handleVerifyImageBatch(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
    expect(findProjectById).not.toHaveBeenCalled();
    expect(enqueueOracleVerification).not.toHaveBeenCalled();
  });
});

describe('handleUpsertGeofence — polygon bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[B3-performance] 400 khi polygon vượt quá giới hạn 100 điểm', async () => {
    const polygon = Array.from({ length: 101 }, (_, index) => ({
      lat: 10 + index * 0.0001,
      lng: 106 + index * 0.0001
    }));
    const req = {
      params: { projectId: 'proj-001' },
      body: { polygon, radiusMeters: 500 },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    } as unknown as AuthenticatedRequest;
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res,
      400,
      expect.any(String),
      'VALIDATION_ERROR',
      expect.any(Array)
    );
    expect(findProjectById).not.toHaveBeenCalled();
    expect(upsertProjectGeofence).not.toHaveBeenCalled();
  });
});

describe('handleUpsertGeofence — validation and ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[B5] trả 401 khi caller chưa đăng nhập', async () => {
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: null
    });
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 401, expect.any(String), 'UNAUTHENTICATED');
    expect(findProjectById).not.toHaveBeenCalled();
    expect(upsertProjectGeofence).not.toHaveBeenCalled();
  });

  it('[B5] chặn payload malformed trước khi truy vấn project hoặc upsert', async () => {
    const req = buildMockRequest({ params: { projectId: 'proj-001' } });
    req.body = null;
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res,
      400,
      expect.any(String),
      'VALIDATION_ERROR',
      expect.arrayContaining([expect.objectContaining({ field: 'body' })])
    );
    expect(findProjectById).not.toHaveBeenCalled();
    expect(upsertProjectGeofence).not.toHaveBeenCalled();
  });

  it('[B5] lưu polygon hợp lệ của owner với bán kính mặc định do server áp dụng', async () => {
    const polygon = [
      { lat: 10.76, lng: 106.68 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 }
    ];
    const geofence = { projectId: 'proj-001', polygon, centroid: { lat: 10.763, lng: 106.69 }, radiusMeters: 500 };
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord() as never);
    vi.mocked(upsertProjectGeofence).mockResolvedValue(geofence as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    req.body = { polygon };
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(upsertProjectGeofence).toHaveBeenCalledWith('proj-001', polygon, 500);
    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), geofence);
  });

  it('[B5] trả 403 khi Organization không sở hữu project cần cập nhật', async () => {
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord({ organizationId: 'org-other' }) as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    req.body = { polygon: [{ lat: 10.76, lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] };
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 403, expect.any(String), 'FORBIDDEN');
    expect(upsertProjectGeofence).not.toHaveBeenCalled();
  });

  it('[B5] trả 404 khi project cần cập nhật không tồn tại', async () => {
    vi.mocked(findProjectById).mockResolvedValue(null);
    const req = buildMockRequest({
      params: { projectId: 'proj-missing' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    req.body = { polygon: [{ lat: 10.76, lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] };
    const res = buildMockResponse();

    await handleUpsertGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 404, expect.any(String), 'NOT_FOUND');
    expect(upsertProjectGeofence).not.toHaveBeenCalled();
  });
});

describe('handleGetGeofence — ownership by role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[B5] trả 401 khi caller chưa đăng nhập', async () => {
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: null
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 401, expect.any(String), 'UNAUTHENTICATED');
    expect(findProjectById).not.toHaveBeenCalled();
    expect(findGeofenceByProjectId).not.toHaveBeenCalled();
  });

  it('[B5] trả 404 khi Organization đọc project không tồn tại', async () => {
    vi.mocked(findProjectById).mockResolvedValue(null);
    const req = buildMockRequest({
      params: { projectId: 'proj-missing' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 404, expect.any(String), 'NOT_FOUND');
    expect(findGeofenceByProjectId).not.toHaveBeenCalled();
  });

  it('[B5] trả geofence cho Organization sở hữu project', async () => {
    const geofence = { projectId: 'proj-001', polygon: [], centroid: { lat: 10.76, lng: 106.68 }, radiusMeters: 500 };
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord() as never);
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(geofence as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), geofence);
  });

  it('[B5] trả 404 cho owner khi project chưa có geofence', async () => {
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord() as never);
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(null);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 404, expect.any(String), 'NOT_FOUND');
  });

  it('[B5] chặn Organization đọc geofence project của organization khác trước khi query geofence', async () => {
    vi.mocked(findProjectById).mockResolvedValue(buildProjectRecord({ organizationId: 'org-other' }) as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'org-001', role: 'organizations' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 403, expect.any(String), 'FORBIDDEN');
    expect(findGeofenceByProjectId).not.toHaveBeenCalled();
  });

  it('[B5] giữ quyền đọc geofence cho Admin phục vụ review B3', async () => {
    const geofence = { projectId: 'proj-001', polygon: [], centroid: { lat: 10.76, lng: 106.68 }, radiusMeters: 500 };
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(geofence as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'admin-1', role: 'admin' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(findProjectById).not.toHaveBeenCalled();
    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), geofence);
  });

  it('[B5] giữ quyền đọc geofence cho Regulatory phục vụ review B3', async () => {
    const geofence = { projectId: 'proj-001', polygon: [], centroid: { lat: 10.76, lng: 106.68 }, radiusMeters: 500 };
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(geofence as never);
    const req = buildMockRequest({
      params: { projectId: 'proj-001' },
      authenticatedUser: { userId: 'regulatory-1', role: 'regulatory' }
    });
    const res = buildMockResponse();

    await handleGetGeofence(req, res);

    expect(findProjectById).not.toHaveBeenCalled();
    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), geofence);
  });
});

// ─── Tests: handleGetOverrideRequestById ─────────────────────────────────────

describe('handleGetOverrideRequestById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // [B4-fix #6] findProjectById mặc định trả null → controller fallback sang projectId
    vi.mocked(findProjectById).mockResolvedValue(null as never);
    // [B3] Mặc định không có snapshot → geofenceSnapshot = null (record cũ hoặc NO_GEOFENCE)
    vi.mocked(findVerificationById).mockResolvedValue(null);
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

// ─── Tests: handleVoteOverrideRequest (Zod validation) ─────────────────────────

import { handleVoteOverrideRequest } from '../../controllers/oracleController';
import { submitOverrideVote } from '../../services/overrideVotingService';

describe('handleVoteOverrideRequest — Zod validation (B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildVoteRequest(overrides: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    authenticatedUser?: { userId: string; role: string } | null;
  } = {}): AuthenticatedRequest {
    return {
      params: { overrideRequestId: 'req-001', ...overrides.params },
      body: overrides.body ?? {},
      authenticatedUser: overrides.authenticatedUser !== undefined
        ? overrides.authenticatedUser
        : { userId: 'admin-1', role: 'admin' },
      query: {}
    } as unknown as AuthenticatedRequest;
  }

  it('[T5] 401 khi chưa đăng nhập', async () => {
    const req = buildVoteRequest({ authenticatedUser: null });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 401, expect.any(String), 'UNAUTHENTICATED');
  });

  it('[T5] 400 khi vote không phải APPROVE hoặc REJECT (Zod enum)', async () => {
    const req = buildVoteRequest({ body: { vote: 'INVALID', reason: 'Lý do đủ dài để pass validation' } });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('[T5] 400 khi thiếu reason', async () => {
    const req = buildVoteRequest({ body: { vote: 'APPROVE' } });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('[T5] 400 khi reason dưới 10 ký tự', async () => {
    const req = buildVoteRequest({ body: { vote: 'APPROVE', reason: 'ngắn' } });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.stringContaining('10'), 'VALIDATION_ERROR');
  });

  // [B4-fix T-reason-control] Reject control characters in reason
  it('[T5] 400 khi reason chứa control characters (e.g. \\u0000, \\u0007, \\u001B)', async () => {
    const req = buildVoteRequest({ body: { vote: 'APPROVE', reason: 'Lý do có\u0000ký tự control' } });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res,
      400,
      expect.stringContaining('điều khiển'),
      'VALIDATION_ERROR'
    );
    expect(submitOverrideVote).not.toHaveBeenCalled();
  });

  it('[T5] 400 khi body rỗng hoàn toàn', async () => {
    const req = buildVoteRequest({ body: {} });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('[T5] 403 khi user không phải admin hoặc regulatory', async () => {
    const req = buildVoteRequest({
      authenticatedUser: { userId: 'user-1', role: 'donor' },
      body: { vote: 'APPROVE', reason: 'Lý do hợp lệ đủ dài để pass Zod' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(res, 403, expect.any(String), 'FORBIDDEN');
  });

  it('[T5] 200 khi body hợp lệ và vote được ghi nhận thành công', async () => {
    // [B4-fix #2] IDOR: caller phải có trong snapshot VÀ role phải khớp
    vi.mocked(findCommissionerInSnapshot).mockResolvedValue({
      userId: 'admin-1',
      role: 'admin'
    });
    vi.mocked(submitOverrideVote).mockResolvedValue({
      outcome: 'VOTE_RECORDED',
      pendingVoters: 2,
      totalVoters: 3
    } as never);
    const req = buildVoteRequest({
      body: { vote: 'APPROVE', reason: 'Lý do đủ dài để pass Zod validation' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), expect.objectContaining({ outcome: 'VOTE_RECORDED' }));
  });

  it('[T5] [B4-fix #2] 403 ROLE_MISMATCH khi role của caller khác snapshot', async () => {
    // IDOR: admin bị demote xuống 'donor' nhưng cố vote bằng JWT hiện tại (vẫn có role cũ từ snapshot)
    vi.mocked(findCommissionerInSnapshot).mockResolvedValue({
      userId: 'admin-1',
      role: 'admin'  // snapshot lưu role 'admin'
    });
    // Nhưng JWT hiện tại lại có role 'regulatory'
    const req = buildVoteRequest({
      authenticatedUser: { userId: 'admin-1', role: 'regulatory' },
      body: { vote: 'APPROVE', reason: 'Lý do đủ dài để pass Zod validation' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res, 403, expect.any(String), 'ROLE_MISMATCH'
    );
    // submitOverrideVote KHÔNG được gọi — chặn sớm
    expect(submitOverrideVote).not.toHaveBeenCalled();
  });

  it('[T5] [B4-fix #2] 403 FORBIDDEN khi user không có trong snapshot', async () => {
    vi.mocked(findCommissionerInSnapshot).mockResolvedValue(null);
    const req = buildVoteRequest({
      body: { vote: 'APPROVE', reason: 'Lý do đủ dài để pass Zod validation' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res, 403, expect.any(String), 'FORBIDDEN'
    );
    expect(submitOverrideVote).not.toHaveBeenCalled();
  });

  // ─── T2: Regulatory role path ──────────────────────────────────────────────

  it('[T2-regulatory] 200 vote thành công với role regulatory', async () => {
    // Clone test T5 200 vote thành công, đổi role sang regulatory
    vi.mocked(findCommissionerInSnapshot).mockResolvedValue({
      userId: 'regulatory-1',
      role: 'regulatory'
    });
    vi.mocked(submitOverrideVote).mockResolvedValue({
      outcome: 'VOTE_RECORDED',
      pendingVoters: 2,
      totalVoters: 3
    } as never);
    const req = buildVoteRequest({
      authenticatedUser: { userId: 'regulatory-1', role: 'regulatory' },
      body: { vote: 'APPROVE', reason: 'Cơ quan giám sát xác nhận tọa độ hợp lệ' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(
      res, 200, expect.any(String),
      expect.objectContaining({ outcome: 'VOTE_RECORDED' })
    );
    // submitOverrideVote phải được gọi với đúng role regulatory
    expect(submitOverrideVote).toHaveBeenCalledWith(
      'req-001',
      'regulatory-1',
      'regulatory',
      'APPROVE',
      'Cơ quan giám sát xác nhận tọa độ hợp lệ'
    );
  });

  it('[T2-regulatory] 403 ROLE_MISMATCH khi snapshot là admin nhưng caller có role regulatory', async () => {
    // snapshotEntry.role === 'admin' nhưng caller JWT có role: 'regulatory'
    vi.mocked(findCommissionerInSnapshot).mockResolvedValue({
      userId: 'admin-1',
      role: 'admin'   // snapshot ghi nhận là admin
    });
    // JWT hiện tại nói regulatory — không khớp snapshot
    const req = buildVoteRequest({
      authenticatedUser: { userId: 'admin-1', role: 'regulatory' },
      body: { vote: 'APPROVE', reason: 'Lý do đủ dài để pass Zod validation' }
    });
    const res = buildMockResponse();

    await handleVoteOverrideRequest(req, res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res, 403, expect.any(String), 'ROLE_MISMATCH'
    );
    // submitOverrideVote KHÔNG được gọi — chặn sớm trước khi ghi vote
    expect(submitOverrideVote).not.toHaveBeenCalled();
  });
});

// ─── Tests: handleGetOverrideRequestById — data exposure (B4-fix #3) ─────────

describe('handleGetOverrideRequestById — data exposure (B4-fix #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // [B4-fix #6] Mặc định project không tìm thấy để test fallback
    vi.mocked(findProjectById).mockResolvedValue(null as never);
    // [B3] Mặc định không có snapshot → geofenceSnapshot = null
    vi.mocked(findVerificationById).mockResolvedValue(null);
  });

  it('[T4-fix] commissionerSnapshot KHÔNG lộ userId của người khác', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    // Caller là admin-1
    const req = buildMockRequest({ authenticatedUser: { userId: 'admin-1', role: 'admin' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as {
      commissionerSnapshot: Array<{ userId?: string; role: string; isCurrentUser: boolean }>;
      currentCommissionerRole: string | null;
    };

    // userId KHÔNG ĐƯỢC xuất hiện ở bất kỳ entry nào
    for (const entry of responseData.commissionerSnapshot) {
      expect(entry.userId).toBeUndefined();
      expect(entry.role).toBeTruthy();
      expect(typeof entry.isCurrentUser).toBe('boolean');
    }
    // currentCommissionerRole trả về role của caller
    expect(responseData.currentCommissionerRole).toBe('admin');
  });

  it('[T4-fix] isCurrentUser đánh dấu đúng entry thuộc về caller', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    // Caller là regulatory-1
    const req = buildMockRequest({ authenticatedUser: { userId: 'regulatory-1', role: 'regulatory' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as {
      commissionerSnapshot: Array<{ role: string; isCurrentUser: boolean }>;
    };

    // Chỉ đúng 1 entry có isCurrentUser = true — entry của regulatory-1
    const currentEntries = responseData.commissionerSnapshot.filter(e => e.isCurrentUser);
    expect(currentEntries).toHaveLength(1);
    expect(currentEntries[0]?.role).toBe('regulatory');
  });

  // [B4-fix #6] projectName enrichment từ projectModel — drawer phải hiển thị tên dự án
  it('[T4-fix-pname] trả projectName từ projectModel và projectDisplayName fallback khi tìm thấy', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    vi.mocked(findProjectById).mockResolvedValue({
      projectId: 'proj-001',
      name: 'Xây dựng trường học ABC',
      organizationId: 'org-001',
      description: '',
      goalAmount: 0,
      deadline: new Date(),
      status: 'ACTIVE',
      evidenceCids: [],
      evidenceFiles: [],
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
      createdAt: new Date(),
      updatedAt: new Date()
    } as never);
    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { projectName: string | null; projectDisplayName: string };
    expect(responseData.projectName).toBe('Xây dựng trường học ABC');
    expect(responseData.projectDisplayName).toBe('Xây dựng trường học ABC');
  });

  it('[T4-fix-pname-fallback] projectDisplayName fallback về projectId khi lookup thất bại', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    vi.mocked(findProjectById).mockResolvedValue(null);
    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { projectName: string | null; projectDisplayName: string };
    expect(responseData.projectName).toBeNull();
    // Fallback rõ ràng về projectId khi project không tồn tại
    expect(responseData.projectDisplayName).toBe('proj-001');
  });

  // [B4-fix-T-multiadmin] Multi-admin: khi snapshot có nhiều admin, isCurrentUser phải đúng theo userId của caller
  // và chỉ một entry được đánh dấu — tránh regression đánh dấu theo role.
  it('[T4-fix] multi-admin: chỉ admin-1 là isCurrentUser khi caller là admin-1', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest() as never
    );
    const req = buildMockRequest({ authenticatedUser: { userId: 'admin-1', role: 'admin' } });
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as {
      commissionerSnapshot: Array<{ role: string; isCurrentUser: boolean }>;
    };

    const currentEntries = responseData.commissionerSnapshot.filter(e => e.isCurrentUser);
    expect(currentEntries).toHaveLength(1);
    expect(currentEntries[0]?.role).toBe('admin');
    // admin-2 trong snapshot không bị đánh dấu dù cùng role
    const admin2Entries = responseData.commissionerSnapshot.filter(e => e.role === 'admin' && !e.isCurrentUser);
    expect(admin2Entries.length).toBeGreaterThanOrEqual(1);
  });

  // [B3-BE-01] Detail endpoint enrich geofenceSnapshot bất biến từ verification result
  it('[B3] trả geofenceSnapshot từ verification result cho Admin/Regulatory', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({ verificationId: 'verif-001' }) as never
    );
    const snapshot = {
      polygon: [
        { lat: 10.77, lng: 106.70 },
        { lat: 10.78, lng: 106.70 },
        { lat: 10.78, lng: 106.71 }
      ],
      centroid: { lat: 10.775, lng: 106.703 },
      radiusMeters: 1000
    };
    vi.mocked(findVerificationById).mockResolvedValue({ geofenceSnapshot: snapshot } as never);

    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { geofenceSnapshot: typeof snapshot | null };
    expect(responseData.geofenceSnapshot).toEqual(snapshot);
    expect(responseData.geofenceSnapshot?.radiusMeters).toBe(1000);
  });

  // [B3-BE-01] Record cũ thiếu snapshot → trả null (FE hiển thị banner cảnh báo, không vẽ data giả)
  it('[B3] trả geofenceSnapshot = null khi verification record cũ chưa có snapshot', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({ verificationId: 'verif-legacy' }) as never
    );
    vi.mocked(findVerificationById).mockResolvedValue({ geofenceSnapshot: null } as never);

    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { geofenceSnapshot: unknown; geofenceSnapshotUnavailable: boolean };
    expect(responseData.geofenceSnapshot).toBeNull();
    // Record cũ thật sự không có snapshot → KHÔNG bật cờ unavailable (phân biệt với lỗi đọc DB)
    expect(responseData.geofenceSnapshotUnavailable).toBe(false);
  });

  // [B3-fix] Đọc verification thất bại (DB lỗi) → KHÔNG nuốt thành null im lặng.
  // Trả HTTP 200 nhưng bật cờ geofenceSnapshotUnavailable=true để FE hiển thị lỗi/retry riêng,
  // tránh reviewer hiểu nhầm "record cũ thiếu snapshot" khi thực chất dữ liệu không tải được.
  it('[B3] bật geofenceSnapshotUnavailable=true khi đọc verification thất bại (không nuốt lỗi)', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildOverrideRequest({ verificationId: 'verif-db-error' }) as never
    );
    vi.mocked(findVerificationById).mockRejectedValue(new Error('Mongo connection lost'));

    const req = buildMockRequest();
    const res = buildMockResponse();

    await handleGetOverrideRequestById(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as { geofenceSnapshot: unknown; geofenceSnapshotUnavailable: boolean };
    expect(responseData.geofenceSnapshot).toBeNull();
    expect(responseData.geofenceSnapshotUnavailable).toBe(true);
  });
});

// ─── Tests: handleGetPendingOverrides — data exposure (B4-fix #3) ────────────

describe('handleGetPendingOverrides — data exposure (B4-fix #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // [B4-fix #6] Mặc định project không tìm thấy → fallback projectDisplayName = projectId
    vi.mocked(findProjectById).mockResolvedValue(null as never);
    // [P1-fix] List endpoint batch lookup projectName qua findProjectsByIdList — mặc định mảng rỗng
    vi.mocked(findProjectsByIdList).mockResolvedValue([] as never);
  });

  function buildListRequest(): AuthenticatedRequest {
    return {
      params: {},
      query: {},
      authenticatedUser: { userId: 'admin-1', role: 'admin' }
    } as unknown as AuthenticatedRequest;
  }

  it('[T4-fix-list] items KHÔNG lộ userId trong commissionerSnapshot', async () => {
    vi.mocked(findPendingOverrideRequests).mockResolvedValue([
      buildOverrideRequest() as never
    ]);
    vi.mocked((await import('../../models/oracleOverrideRequestModel')).countPendingOverrideRequests)
      .mockResolvedValue(1);

    const req = buildListRequest();
    const res = buildMockResponse();

    await handleGetPendingOverrides(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as {
      items: Array<{
        commissionerSnapshot: Array<{ userId?: string; role: string; isCurrentUser: boolean }>;
        currentCommissionerRole: string | null;
        projectDisplayName: string;
        projectName: string | null;
      }>;
    };

    expect(responseData.items).toHaveLength(1);
    for (const item of responseData.items) {
      for (const entry of item.commissionerSnapshot) {
        expect(entry.userId).toBeUndefined();
      }
      expect(item.currentCommissionerRole).toBe('admin');
      // Fallback về projectId khi lookup fail
      expect(item.projectName).toBeNull();
      expect(item.projectDisplayName).toBe('proj-001');
    }
  });

  // [B3-BE-01] List KHÔNG lộ geofenceSnapshot và KHÔNG gọi findVerificationById (tránh N+1 + rò rỉ data)
  it('[B3] list không kèm geofenceSnapshot và không truy vấn verification theo từng item', async () => {
    vi.mocked(findPendingOverrideRequests).mockResolvedValue([
      buildOverrideRequest({ overrideRequestId: 'req-001', projectId: 'proj-001', verificationId: 'verif-001' }) as never,
      buildOverrideRequest({ overrideRequestId: 'req-002', projectId: 'proj-002', verificationId: 'verif-002' }) as never
    ]);
    vi.mocked((await import('../../models/oracleOverrideRequestModel')).countPendingOverrideRequests)
      .mockResolvedValue(2);

    const req = buildListRequest();
    const res = buildMockResponse();

    await handleGetPendingOverrides(req, res);

    const callArgs = vi.mocked(sendSuccessResponse).mock.calls[0];
    const responseData = callArgs?.[3] as {
      items: Array<Record<string, unknown>>;
    };

    expect(responseData.items).toHaveLength(2);
    for (const item of responseData.items) {
      expect(item.geofenceSnapshot).toBeUndefined();
    }
    // Không có lookup verification per-item ở list endpoint
    expect(vi.mocked(findVerificationById)).not.toHaveBeenCalled();
  });
});
