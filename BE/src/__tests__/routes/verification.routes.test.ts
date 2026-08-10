/**
 * Test route/controller cho verification endpoints — không dùng database thật.
 * Rate limit được mock tại đây; hành vi rate limit thật nằm ở verification.rateLimit.test.ts.
 */
import express, { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (
    _request: express.Request,
    _response: express.Response,
    next: express.NextFunction
  ) => next()
}));

vi.mock('../../services/verification.service', () => ({
  verifyTransaction: vi.fn(),
  getProjectSummary: vi.fn()
}));

import { handleVerifyTransaction, handleGetProjectSummary } from '../../controllers/verificationController';
import { createVerificationRoutes } from '../../routes/verification.routes';
import { getProjectSummary, verifyTransaction } from '../../services/verification.service';

/** Tạo Express app tối giản để kiểm tra route verification với service đã mock. */
function createTestApplication(): express.Application {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/api/transparency', createVerificationRoutes());
  return testApplication;
}

/** Tạo response mock để kiểm tra trực tiếp nhánh validation của controller. */
function createResponseMock(): Response {
  const response = {
    status: vi.fn(),
    json: vi.fn()
  } as unknown as Response;
  vi.mocked(response.status).mockReturnValue(response);
  return response;
}

describe('verification routes - logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về 200 cho verify có thông tin PayOS', async () => {
    vi.mocked(verifyTransaction).mockResolvedValue({
      found: true,
      correlationId: 'deposit:1001',
      source: 'PAYOS',
      payos: {
        orderCode: '1001',
        amount: 50000,
        status: 'PAYMENT_CONFIRMED',
        timestamp: '2024-06-15T10:30:00.000Z'
      },
      projectTotalRaised: null,
      projectTotalDisbursed: null,
      projectDisbursementCount: null,
      disbursedRatioBps: null,
      cached: false,
      fallbackMode: false
    });

    const response = await request(createTestApplication())
      .get('/api/transparency/verify/deposit%3A1001');

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(true);
    expect(response.body.payos.orderCode).toBe('1001');
  });

  it('trả về 200 cho verify có thông tin chain', async () => {
    vi.mocked(verifyTransaction).mockResolvedValue({
      found: true,
      correlationId: 'donation:0xhash',
      source: 'BLOCKCHAIN',
      chain: {
        txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        blockNumber: 123,
        status: 'CONFIRMED'
      },
        projectTotalRaised: 100000,
        projectTotalDisbursed: 50000,
        projectDisbursementCount: 1,
      disbursedRatioBps: 5000,
      cached: false,
      fallbackMode: false
    });

    const response = await request(createTestApplication())
      .get('/api/transparency/verify/donation%3A0xhash');

    expect(response.status).toBe(200);
    expect(response.body.chain).toEqual({
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      blockNumber: 123,
      status: 'CONFIRMED'
    });
  });

  it('trả về summary với đủ các chỉ số tài chính', async () => {
    vi.mocked(getProjectSummary).mockResolvedValue({
      projectId: 'project-1',
      totalRaised: 12000000,
      totalDisbursed: 8000000,
      remaining: 4000000,
      donorCount: 2,
      transactionCount: 3,
      disbursementCount: 2,
      disbursedAmounts: [5000000, 3000000],
      excludedReorgedVnd: 0,
      excludedReorgedCount: 0,
      overDisbursed: false,
      cached: false,
      fallbackMode: false
    });

    const response = await request(createTestApplication())
      .get('/api/transparency/summary/project-1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalRaised: 12000000,
      totalDisbursed: 8000000,
      remaining: 4000000,
      donorCount: 2,
      transactionCount: 3
    });
  });

  it('trả về summary zero-value với danh sách giải ngân rỗng', async () => {
    vi.mocked(getProjectSummary).mockResolvedValue({
      projectId: 'empty-project',
      totalRaised: 0,
      totalDisbursed: 0,
      remaining: 0,
      donorCount: 0,
      transactionCount: 0,
      disbursementCount: 0,
      disbursedAmounts: [],
      excludedReorgedVnd: 0,
      excludedReorgedCount: 0,
      overDisbursed: false,
      cached: false,
      fallbackMode: false
    });

    const response = await request(createTestApplication())
      .get('/api/transparency/summary/empty-project');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalRaised: 0,
      totalDisbursed: 0,
      remaining: 0,
      disbursedAmounts: []
    });
  });

  it('trả về 404 khi correlationId không tồn tại', async () => {
    vi.mocked(verifyTransaction).mockResolvedValue({
      found: false,
      correlationId: 'missing:1',
      source: null,
      projectTotalRaised: null,
      projectTotalDisbursed: null,
      projectDisbursementCount: null,
      disbursedRatioBps: null,
      cached: false,
      fallbackMode: false
    });

    const response = await request(createTestApplication())
      .get('/api/transparency/verify/missing%3A1');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      errorCode: 'TRANSACTION_NOT_FOUND',
      correlationId: 'missing:1'
    });
  });

  it('trả về 400 khi correlationId rỗng tại controller', async () => {
    const response = createResponseMock();

    await handleVerifyTransaction(
      { params: { correlationId: '' } } as unknown as Request,
      response
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Tham số không hợp lệ.',
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'correlationId', message: 'correlationId is required' }],
      correlationId: null
    });
  });

  it('trả về 400 khi projectId rỗng tại controller', async () => {
    const response = createResponseMock();

    await handleGetProjectSummary(
      { params: { projectId: '' } } as unknown as Request,
      response
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Tham số không hợp lệ.',
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'projectId', message: 'projectId is required' }],
      correlationId: null
    });
  });

  it('trả về envelope 400 khi HTTP param chỉ có khoảng trắng', async () => {
    const response = await request(createTestApplication())
      .get('/api/transparency/summary/%20');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'projectId', message: 'projectId is required' }]
    });
  });

  it('từ chối public param quá dài để tránh query/cache key abuse', async () => {
    const oversizedProjectId = 'p'.repeat(257);

    const response = await request(createTestApplication())
      .get(`/api/transparency/summary/${oversizedProjectId}`);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'projectId', message: 'projectId is too long' }]
    });
    expect(getProjectSummary).not.toHaveBeenCalled();
  });

  it('trả về 500 khi verify service throw lỗi', async () => {
    vi.mocked(verifyTransaction).mockRejectedValue(new Error('database unavailable'));

    const response = await request(createTestApplication())
      .get('/api/transparency/verify/deposit%3A500');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      correlationId: 'deposit:500'
    });
  });

  it('trả về 500 khi summary service throw lỗi', async () => {
    vi.mocked(getProjectSummary).mockRejectedValue(new Error('database unavailable'));

    const response = await request(createTestApplication())
      .get('/api/transparency/summary/project-500');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      correlationId: null
    });
  });
});
