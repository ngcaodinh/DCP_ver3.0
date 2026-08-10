/**
 * Integration test cho rate limiting của verification routes.
 * Hai endpoint dùng chung một bucket theo quyết định QĐ-8 trong plan D3.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/verification.service', () => ({
  verifyTransaction: vi.fn().mockResolvedValue({
    found: false,
    correlationId: 'missing:1',
    source: null,
    projectTotalRaised: null,
    projectTotalDisbursed: null,
    projectDisbursementCount: null,
    disbursedRatioBps: null,
    cached: false,
    fallbackMode: false
  }),
  getProjectSummary: vi.fn().mockResolvedValue({
    projectId: 'project-1',
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
  })
}));

import { createVerificationRoutes } from '../../routes/verification.routes';
import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';

/** Tạo app test có rate limiter thật và service mock. */
function createTestApplication(): express.Application {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/api/transparency', createVerificationRoutes());
  return testApplication;
}

describe('verification routes - rate limit integration', () => {
  beforeEach(() => {
    // Reset singleton Map để mỗi test kiểm tra đúng quota 100 request.
    __resetRateLimitStore();
  });

  it('request thứ 101 trong 60 giây trả về 429', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 100; requestIndex++) {
      const response = await request(testApplication)
        .get('/api/transparency/summary/project-1');
      expect(response.status).toBe(200);
    }

    const blockedResponse = await request(testApplication)
      .get('/api/transparency/summary/project-1');

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body.success).toBe(false);
    expect(blockedResponse.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('hai endpoint dùng chung quota theo IP', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 100; requestIndex++) {
      await request(testApplication).get('/api/transparency/summary/project-1');
    }

    const blockedVerifyResponse = await request(testApplication)
      .get('/api/transparency/verify/missing%3A1');

    expect(blockedVerifyResponse.status).toBe(429);
    expect(blockedVerifyResponse.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });
});
