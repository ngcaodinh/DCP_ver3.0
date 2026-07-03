/**
 * Unit tests cho adminDashboardController.ts — Guest Sessions admin endpoints.
 * Bao gồm: handleGetAdminGuestSessionSummary, handleListAdminGuestSessions,
 * handleInvalidateAdminGuestSession và các helper functions.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

/**
 * Mock config/logger
 */
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

/**
 * Mock services — chỉ mock những hàm được test controller gọi
 */
vi.mock('../../services/adminDashboardService', () => ({
  getAdminGuestSessionSummary: vi.fn(),
  listAdminGuestSessions: vi.fn(),
  invalidateAdminGuestSession: vi.fn()
}));

/**
 * Mock ApplicationError và AuthorizationError để controller có thể dùng instanceof check.
 * AuthorizationError phải extend ApplicationError để instanceof check trong
 * sendErrorFromUnknown (dùng mock ApplicationError) hoạt động đúng trong tests.
 */
vi.mock('../../utils/applicationError', () => {
  class MockApplicationError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: string;

    constructor(message: string, statusCode: number, errorCode: string) {
      super(message);
      this.name = 'ApplicationError';
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }

  class MockAuthorizationError extends MockApplicationError {
    constructor(message: string) {
      super(message, 403, 'FORBIDDEN');
      this.name = 'AuthorizationError';
    }
  }

  return {
    ApplicationError: MockApplicationError,
    AuthorizationError: MockAuthorizationError
  };
});

// Import sau vi.mock để dùng class đã bị mock trong test bodies
import { ApplicationError } from '../../utils/applicationError';

import {
  handleGetAdminGuestSessionSummary,
  handleListAdminGuestSessions,
  handleInvalidateAdminGuestSession
} from '../../controllers/adminDashboardController';
import {
  getAdminGuestSessionSummary,
  listAdminGuestSessions,
  invalidateAdminGuestSession
} from '../../services/adminDashboardService';

interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
}

interface MockRequestParams {
  authenticatedUser?: AuthenticatedUser | null;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/**
 * Tạo mock AuthenticatedRequest với các overrides.
 */
function createMockRequest(params: MockRequestParams = {}): Request {
  return {
    authenticatedUser: params.authenticatedUser ?? null,
    query: params.query ?? {},
    params: params.params ?? {},
    body: params.body ?? {}
  } as unknown as Request;
}

/**
 * Tạo mock Response object với chainable methods.
 */
function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response;
}

/** Mock admin user hợp lệ */
const mockAdminUser: AuthenticatedUser = {
  userId: 'admin-001',
  email: 'admin@example.com',
  role: 'admin'
};

/** Mock guest session summary response */
const mockGuestSessionSummary = {
  activeCount: 42,
  expiredCount: 10,
  claimedCount: 5,
  purgedCount: 3,
  totalSponsoredGas: 1500000,
  totalDonatedAmount: 5000000,
  totalDonationCount: 57
};

/** Mock paginated guest session list */
const mockGuestSessionList = {
  sessions: [
    {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
      status: 'ACTIVE' as const,
      donationCount: 2,
      totalDonatedAmount: 10000,
      totalSponsoredGas: 5000,
      renewalCount: 1,
      deviceFingerprintHash: 'a1b2c3d4e5f6...',
      ipAddress: '192.168.1.100',
      hasPendingDonation: false,
      claimedByUserId: null,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  totalCount: 1,
  pageCount: 1,
  page: 1,
  limit: 20
};

// =============================================================================
// handleGetAdminGuestSessionSummary TESTS
// =============================================================================

describe('handleGetAdminGuestSessionSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is not authenticated', async () => {
    const req = createMockRequest({ authenticatedUser: null });
    const res = createMockResponse();

    await handleGetAdminGuestSessionSummary(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'UNAUTHENTICATED'
      })
    );
  });

  it('should return 401 when authenticatedUser is undefined', async () => {
    const req = createMockRequest({ authenticatedUser: undefined });
    const res = createMockResponse();

    await handleGetAdminGuestSessionSummary(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 200 with summary data when authenticated', async () => {
    vi.mocked(getAdminGuestSessionSummary).mockResolvedValue(mockGuestSessionSummary);
    const req = createMockRequest({ authenticatedUser: mockAdminUser });
    const res = createMockResponse();

    await handleGetAdminGuestSessionSummary(req, res);

    expect(getAdminGuestSessionSummary).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: mockGuestSessionSummary
      })
    );
  });

  it('should propagate service errors correctly', async () => {
    vi.mocked(getAdminGuestSessionSummary).mockRejectedValue(
      new ApplicationError('Database error', 500, 'INTERNAL_ERROR')
    );
    const req = createMockRequest({ authenticatedUser: mockAdminUser });
    const res = createMockResponse();

    await handleGetAdminGuestSessionSummary(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INTERNAL_ERROR'
      })
    );
  });
});

// =============================================================================
// handleListAdminGuestSessions TESTS
// =============================================================================

describe('handleListAdminGuestSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is not authenticated', async () => {
    const req = createMockRequest({ authenticatedUser: null });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'UNAUTHENTICATED'
      })
    );
  });

  it('should return 200 with paginated list using default pagination', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: {}
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 20, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: mockGuestSessionList
      })
    );
  });

  it('should parse and pass pagination params to service', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { page: '3', limit: '50' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(3, 50, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should clamp page to minimum 1 for invalid values', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { page: '-5', limit: '20' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 20, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should clamp limit to 1-100 range', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { page: '1', limit: '999' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 100, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should clamp limit to 1 when value is below range', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { page: '1', limit: '0' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 1, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should return 400 for invalid status value', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { status: 'INVALID_STATUS' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_STATUS'
      })
    );
    expect(listAdminGuestSessions).not.toHaveBeenCalled();
  });

  it('should return 200 with valid status filter', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { status: 'ACTIVE' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(
      1,
      20,
      expect.objectContaining({ status: 'ACTIVE' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should pass all valid filters to service', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: {
        status: 'EXPIRED',
        walletAddress: '0x742d35cc',
        ipAddress: '192.168.1',
        startDate: '2024-01-01',
        endDate: '2024-12-31'
      }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 20, expect.objectContaining({
      status: 'EXPIRED',
      walletAddress: '0x742d35cc',
      ipAddress: '192.168.1',
      startDate: '2024-01-01',
      endDate: '2024-12-31'
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should use default pagination when page/limit are non-numeric strings', async () => {
    vi.mocked(listAdminGuestSessions).mockResolvedValue(mockGuestSessionList);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: { page: 'abc', limit: 'xyz' }
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(listAdminGuestSessions).toHaveBeenCalledWith(1, 20, expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should propagate service errors correctly', async () => {
    vi.mocked(listAdminGuestSessions).mockRejectedValue(
      new ApplicationError('Database connection failed', 503, 'SERVICE_UNAVAILABLE')
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      query: {}
    });
    const res = createMockResponse();

    await handleListAdminGuestSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'SERVICE_UNAVAILABLE'
      })
    );
  });
});

// =============================================================================
// handleInvalidateAdminGuestSession TESTS
// =============================================================================

describe('handleInvalidateAdminGuestSession', () => {
  const validSessionId = '550e8400-e29b-41d4-a716-446655440000';
  const mockInvalidateResult = {
    sessionId: validSessionId,
    status: 'EXPIRED'
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is not authenticated', async () => {
    const req = createMockRequest({ authenticatedUser: null });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'UNAUTHENTICATED'
      })
    );
  });

  it('should return 400 when sessionId is empty', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: '' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_ID'
      })
    );
    expect(invalidateAdminGuestSession).not.toHaveBeenCalled();
  });

  it('should return 400 when sessionId is whitespace-only', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: '   ' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_ID'
      })
    );
    expect(invalidateAdminGuestSession).not.toHaveBeenCalled();
  });

  it('should return 400 when sessionId is not a valid UUID', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: 'not-a-uuid' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_ID'
      })
    );
    expect(invalidateAdminGuestSession).not.toHaveBeenCalled();
  });

  it('should return 400 when sessionId contains path traversal characters', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: '../../../etc/passwd' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_ID'
      })
    );
    expect(invalidateAdminGuestSession).not.toHaveBeenCalled();
  });

  it('should return 400 when sessionId contains regex metacharacters', async () => {
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: '.*' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_GUEST_SESSION_ID'
      })
    );
  });

  it('should return 200 with success result for valid UUID', async () => {
    vi.mocked(invalidateAdminGuestSession).mockResolvedValue(mockInvalidateResult);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(invalidateAdminGuestSession).toHaveBeenCalledWith(validSessionId, 'admin');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: mockInvalidateResult
      })
    );
  });

  it('should return 404 when session does not exist', async () => {
    vi.mocked(invalidateAdminGuestSession).mockRejectedValue(
      new ApplicationError('Không tìm thấy guest session.', 404, 'NOT_FOUND')
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'NOT_FOUND'
      })
    );
  });

  it('should return 409 when session is already inactive (not ACTIVE)', async () => {
    vi.mocked(invalidateAdminGuestSession).mockRejectedValue(
      new ApplicationError(
        "Session đang ở trạng thái 'EXPIRED', không cần vô hiệu hóa.",
        409,
        'GUEST_SESSION_ALREADY_INACTIVE'
      )
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'GUEST_SESSION_ALREADY_INACTIVE'
      })
    );
  });

  it('should return 400 when service reports validation error', async () => {
    vi.mocked(invalidateAdminGuestSession).mockRejectedValue(
      new ApplicationError('sessionId không hợp lệ.', 400, 'VALIDATION_ERROR')
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'VALIDATION_ERROR'
      })
    );
  });

  it('should handle lowercase UUID variants', async () => {
    vi.mocked(invalidateAdminGuestSession).mockResolvedValue(mockInvalidateResult);
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: '550e8400-e29b-41d4-a716-446655440000' }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(invalidateAdminGuestSession).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000', 'admin');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should propagate unexpected errors as 500', async () => {
    vi.mocked(invalidateAdminGuestSession).mockRejectedValue(
      new Error('Unexpected error')
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'INTERNAL_ERROR'
      })
    );
  });

  it('should return 403 when service throws AuthorizationError', async () => {
    const { AuthorizationError } = await import('../../utils/applicationError');
    vi.mocked(invalidateAdminGuestSession).mockRejectedValue(
      new AuthorizationError('Chỉ admin mới có quyền vô hiệu hóa guest session.')
    );
    const req = createMockRequest({
      authenticatedUser: mockAdminUser,
      params: { sessionId: validSessionId }
    });
    const res = createMockResponse();

    await handleInvalidateAdminGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'FORBIDDEN'
      })
    );
  });
});
