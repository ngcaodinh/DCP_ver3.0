/**
 * Test cho feedbackBatchController.ts - kiểm tra HTTP handling logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

// Mock các dependencies trước khi import controller
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/feedbackBatch.service', () => ({
  processCsvBatchFeedback: vi.fn(),
  processJsonBatchFeedback: vi.fn(),
  MAX_BATCH_SIZE: 1000,
  MAX_UPLOAD_SIZE_BYTES: 5 * 1024 * 1024
}));

import { batchUploadFeedbackController } from '../../controllers/feedbackBatchController';
import { processCsvBatchFeedback, processJsonBatchFeedback } from '../../services/feedbackBatch.service';
import { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

describe('feedbackBatchController', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockJson: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockJson = vi.fn();
    mockStatus = vi.fn().mockReturnThis();
    mockSend = vi.fn().mockReturnThis();

    mockResponse = {
      status: mockStatus,
      json: mockJson,
      send: mockSend
    };
  });

  const createAuthenticatedRequest = (overrides?: Partial<AuthenticatedRequest>): AuthenticatedRequest => {
    const req = {
      headers: {},
      params: {},
      query: {},
      body: {},
      authenticatedUser: {
        userId: 'org123',
        role: 'ngo',
        organizationId: 'org123'
      }
    };
    if (overrides) {
      return { ...req, ...overrides } as unknown as AuthenticatedRequest;
    }
    return req as unknown as AuthenticatedRequest;
  };

  const createUnauthenticatedRequest = (): AuthenticatedRequest => {
    return {
      headers: {},
      params: {},
      query: {},
      body: {},
      authenticatedUser: undefined,
      userId: undefined
    } as unknown as AuthenticatedRequest;
  };

  describe('authentication', () => {
    it('nên return 401 khi user không authenticated', async () => {
      mockRequest = createUnauthenticatedRequest();

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(401);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('xác thực')
      }));
    });

    it('nên return 403 khi userId không hợp lệ', async () => {
      mockRequest = {
        ...createUnauthenticatedRequest(),
        authenticatedUser: { userId: '', role: 'ngo' } as any
      };

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(403);
    });
  });

  describe('CSV upload handling', () => {
    beforeEach(() => {
      mockRequest = createAuthenticatedRequest();
    });

    it('nên return 400 khi không có file', async () => {
      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = undefined;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('CSV')
      }));
    });

    it('nên return 400 khi file size > 5MB', async () => {
      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'test.csv',
        encoding: '7bit',
        mimetype: 'text/csv',
        buffer: Buffer.from('test'),
        size: 5 * 1024 * 1024 + 1
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('size exceeds')
      }));
    });

    it('nên return 400 khi MIME type không hợp lệ', async () => {
      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'test.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        buffer: Buffer.from('test'),
        size: 100
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('CSV')
      }));
    });

    it('nên return 200 với kết quả khi CSV upload thành công', async () => {
      const mockResult = {
        success: 2,
        failed: 0,
        errors: [],
        flaggedCount: 0
      };

      (processCsvBatchFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'feedback.csv',
        encoding: '7bit',
        mimetype: 'text/csv',
        buffer: Buffer.from('test'),
        size: 100
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(processCsvBatchFeedback).toHaveBeenCalled();
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          success: 2,
          failed: 0
        })
      }));
    });

    it('nên accept text/plain MIME type cho CSV', async () => {
      const mockResult = {
        success: 1,
        failed: 0,
        errors: [],
        flaggedCount: 0
      };

      (processCsvBatchFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'feedback.csv',
        encoding: '7bit',
        mimetype: 'text/plain',
        buffer: Buffer.from('test'),
        size: 100
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(processCsvBatchFeedback).toHaveBeenCalled();
    });
  });

  describe('JSON body handling', () => {
    beforeEach(() => {
      mockRequest = createAuthenticatedRequest();
      mockRequest.headers = { 'content-type': 'application/json' };
    });

    it('nên return 400 khi body không phải object hoặc array', async () => {
      mockRequest.body = 'invalid';

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('JSON')
      }));
    });

    it('nên return 400 khi feedbacks không phải array', async () => {
      mockRequest.body = { feedbacks: 'not-array' };

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('nên return 400 khi feedbacks array rỗng', async () => {
      mockRequest.body = [];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('ít nhất 1')
      }));
    });

    it('nên return 400 khi feedbacks > 1000 items', async () => {
      mockRequest.body = Array.from({ length: 1001 }, (_, i) => ({
        projectId: `proj${i}`,
        beneficiaryName: `User${i}`,
        rating: 4,
        comment: `Comment ${i}`,
        submittedAt: '2024-01-15T10:00:00Z'
      }));

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('1000')
      }));
    });

    it('nên return 200 khi JSON array hợp lệ', async () => {
      const mockResult = {
        success: 2,
        failed: 0,
        errors: [],
        flaggedCount: 0
      };

      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(processJsonBatchFeedback).toHaveBeenCalled();
      expect(mockStatus).toHaveBeenCalledWith(200);
    });

    it('nên support direct array body', async () => {
      const mockResult = {
        success: 1,
        failed: 0,
        errors: [],
        flaggedCount: 0
      };

      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(processJsonBatchFeedback).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      mockRequest = createAuthenticatedRequest();
    });

    it('nên return 400 khi Batch size exceeds limit', async () => {
      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Batch size exceeds 1000 limit')
      );

      mockRequest.headers = { 'content-type': 'application/json' };
      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('1000')
      }));
    });

    it('nên return 400 khi File size exceeds', async () => {
      (processCsvBatchFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('File size exceeds 5MB limit')
      );

      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'test.csv',
        encoding: '7bit',
        mimetype: 'text/csv',
        buffer: Buffer.from('test'),
        size: 100
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('size exceeds')
      }));
    });

    it('nên return 400 khi Invalid CSV format', async () => {
      (processCsvBatchFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Invalid CSV format')
      );

      mockRequest.headers = { 'content-type': 'multipart/form-data' };
      mockRequest.file = {
        fieldname: 'file',
        originalname: 'test.csv',
        encoding: '7bit',
        mimetype: 'text/csv',
        buffer: Buffer.from('invalid'),
        size: 100
      } as any;

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringContaining('Invalid CSV')
      }));
    });

    it('nên return 500 khi internal error xảy ra', async () => {
      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      mockRequest.headers = { 'content-type': 'application/json' };
      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: false
      }));
    });

    it('nên return 500 khi error không có message', async () => {
      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error()
      );

      mockRequest.headers = { 'content-type': 'application/json' };
      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockStatus).toHaveBeenCalledWith(500);
    });
  });

  describe('response format', () => {
    it('nên trả về đúng response structure', async () => {
      const mockResult = {
        success: 5,
        failed: 2,
        errors: [
          { rowNumber: 3, reason: 'Rating must be 1-5' },
          { rowNumber: 7, reason: 'projectId là bắt buộc' }
        ],
        flaggedCount: 1
      };

      (processJsonBatchFeedback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      mockRequest = createAuthenticatedRequest();
      mockRequest.headers = { 'content-type': 'application/json' };
      mockRequest.body = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await batchUploadFeedbackController(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response
      );

      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          success: 5,
          failed: 2,
          errors: expect.any(Array),
          flaggedCount: 1
        })
      }));
    });
  });
});
