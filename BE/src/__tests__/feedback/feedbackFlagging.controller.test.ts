/**
 * Test cho feedbackFlaggingController.ts - kiểm tra HTTP handling logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

// Mock config/logger trước khi import controller
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

// Mock services
vi.mock('../../services/feedbackFlagging.service', () => ({
  getFlaggedFeedback: vi.fn(),
  flagFeedbackManually: vi.fn(),
  unflagFeedback: vi.fn(),
  FeedbackNotFoundError: class FeedbackNotFoundError extends Error {
    statusCode = 404;
    errorCode = 'FEEDBACK_NOT_FOUND';
    constructor(message: string) {
      super(message);
      this.name = 'FeedbackNotFoundError';
    }
  },
  FlagValidationError: class FlagValidationError extends Error {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    constructor(message: string) {
      super(message);
      this.name = 'FlagValidationError';
    }
  }
}));

import {
  handleGetFlaggedFeedback,
  handleFlagFeedback,
  handleUnflagFeedback
} from '../../controllers/feedbackFlaggingController';
import {
  getFlaggedFeedback,
  flagFeedbackManually,
  unflagFeedback
} from '../../services/feedbackFlagging.service';
import { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

describe('feedbackFlaggingController', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockJson: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockJson = vi.fn();
    mockStatus = vi.fn().mockReturnThis();

    mockResponse = {
      status: mockStatus,
      json: mockJson
    };
  });

  const createAuthenticatedRequest = (
    overrides?: Partial<AuthenticatedRequest>
  ): AuthenticatedRequest => {
    const req = {
      headers: {},
      params: {},
      query: {},
      body: {},
      authenticatedUser: {
        userId: 'admin123',
        role: 'ADMIN'
      }
    };
    if (overrides) {
      Object.assign(req, overrides);
    }
    return req as unknown as AuthenticatedRequest;
  };

  const createUnauthenticatedRequest = (): AuthenticatedRequest => {
    return {
      headers: {},
      params: {},
      query: {},
      body: {},
      authenticatedUser: undefined
    } as unknown as AuthenticatedRequest;
  };

  describe('handleGetFlaggedFeedback', () => {
    it('nên return 200 với paginated list', async () => {
      const mockPaginatedResult = {
        items: [
          { feedbackId: 'fb001', isFlagged: true, riskScore: 8 }
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1
      };

      (getFlaggedFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPaginatedResult);

      mockRequest = createAuthenticatedRequest();

      await handleGetFlaggedFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          items: mockPaginatedResult.items,
          pagination: expect.objectContaining({
            page: 1,
            limit: 20,
            total: 1
          })
        })
      }));
    });

    it('nên return 400 khi limit > 50', async () => {
      mockRequest = createAuthenticatedRequest({
        query: { limit: '100' }
      });

      await handleGetFlaggedFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('50')
      }));
    });

    it('nên parse pagination params đúng', async () => {
      const mockPaginatedResult = {
        items: [],
        total: 0,
        page: 2,
        limit: 10,
        totalPages: 0
      };

      (getFlaggedFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPaginatedResult);

      mockRequest = createAuthenticatedRequest({
        query: { page: '2', limit: '10' }
      });

      await handleGetFlaggedFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(getFlaggedFeedback).toHaveBeenCalledWith({
        page: 2,
        limit: 10
      });
    });

    it('nên forward projectId filter', async () => {
      const mockPaginatedResult = {
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0
      };

      (getFlaggedFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPaginatedResult);

      mockRequest = createAuthenticatedRequest({
        query: { projectId: 'proj001' }
      });

      await handleGetFlaggedFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(getFlaggedFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj001' })
      );
    });

    it('nên forward minRiskScore filter', async () => {
      const mockPaginatedResult = {
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0
      };

      (getFlaggedFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPaginatedResult);

      mockRequest = createAuthenticatedRequest({
        query: { minRiskScore: '7' }
      });

      await handleGetFlaggedFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(getFlaggedFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ minRiskScore: 7 })
      );
    });
  });

  describe('handleFlagFeedback - authentication', () => {
    it('nên return 401 khi user không authenticated', async () => {
      mockRequest = createUnauthenticatedRequest();

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(401);
    });

    it('nên return 401 khi userId không có trong authenticated request', async () => {
      mockRequest = createAuthenticatedRequest({
        authenticatedUser: { userId: '', role: 'ADMIN' } as never
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(401);
    });
  });

  describe('handleFlagFeedback - functionality', () => {
    it('nên return 200 khi flag thành công', async () => {
      const updatedFeedback = {
        feedbackId: 'fb001',
        isFlagged: true,
        flagReason: 'Manual flag',
        flaggedAt: new Date(),
        flaggedBy: 'admin123'
      };

      (flagFeedbackManually as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedFeedback);

      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: 'Manual flag reason' }
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          feedbackId: 'fb001',
          isFlagged: true
        })
      }));
    });

    it('nên return 400 khi reason không được cung cấp', async () => {
      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: {}
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('bắt buộc')
      }));
    });

    it('nên return 400 khi reason là empty string', async () => {
      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: '   ' }
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('nên return 404 khi feedback không tồn tại', async () => {
      const { FeedbackNotFoundError } = await import('../../services/feedbackFlagging.service');
      (flagFeedbackManually as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FeedbackNotFoundError('nonexistent')
      );

      mockRequest = createAuthenticatedRequest({
        params: { id: 'nonexistent' },
        body: { reason: 'Test reason' }
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(404);
    });

    it('nên return 400 khi reason quá ngắn', async () => {
      const { FlagValidationError } = await import('../../services/feedbackFlagging.service');
      (flagFeedbackManually as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FlagValidationError('Lý do flag phải có ít nhất 5 ký tự.')
      );

      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: 'abc' }
      });

      await handleFlagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });
  });

  describe('handleUnflagFeedback - authentication', () => {
    it('nên return 401 khi user không authenticated', async () => {
      mockRequest = createUnauthenticatedRequest();

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(401);
    });

    it('nên return 401 khi userId không có trong authenticated request', async () => {
      mockRequest = createAuthenticatedRequest({
        authenticatedUser: { userId: '', role: 'ADMIN' } as never
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(401);
    });
  });

  describe('handleUnflagFeedback - functionality', () => {
    it('nên return 200 khi unflag thành công', async () => {
      const updatedFeedback = {
        feedbackId: 'fb001',
        isFlagged: false
      };

      (unflagFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedFeedback);

      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: 'Manual review by admin - legitimate feedback' }
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          feedbackId: 'fb001',
          isFlagged: false
        })
      }));
    });

    it('nên return 404 khi feedback không tồn tại', async () => {
      const { FeedbackNotFoundError } = await import('../../services/feedbackFlagging.service');
      (unflagFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FeedbackNotFoundError('nonexistent')
      );

      mockRequest = createAuthenticatedRequest({
        params: { id: 'nonexistent' },
        body: { reason: 'Test unflag reason' }
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(404);
    });

    it('nên return 400 khi feedbackId không được cung cấp', async () => {
      mockRequest = createAuthenticatedRequest({
        params: {},
        body: { reason: 'Test unflag reason' }
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('nên return 400 khi reason không được cung cấp', async () => {
      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: {}
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('bắt buộc')
      }));
    });

    it('nên return 400 khi reason là empty/whitespace', async () => {
      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: '   ' }
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('nên return 400 khi reason quá ngắn (service throws FlagValidationError)', async () => {
      const { FlagValidationError } = await import('../../services/feedbackFlagging.service');
      (unflagFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FlagValidationError('Lý do phải có ít nhất 5 ký tự.')
      );

      mockRequest = createAuthenticatedRequest({
        params: { id: 'fb001' },
        body: { reason: 'abc' }
      });

      await handleUnflagFeedback(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });
  });
});
