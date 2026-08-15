/**
 * Integration test cho rate limiting của public feedback routes.
 * File riêng vì rate limit store là module-level singleton trong rateLimitMiddleware.ts
 * — phải chạy trong process sạch để tránh pollution từ các test khác.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn()
}));

// Mock logger
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn()
  }))
}));

// Mock service - chỉ cần return empty để verify rate limit không phụ thuộc vào logic
vi.mock('../../services/publicFeedback.service', () => ({
  getPublicFeedbackList: vi.fn().mockResolvedValue({
    feedbacks: [],
    pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
  }),
  getPublicFeedbackStats: vi.fn().mockResolvedValue({
    avgRating: null,
    totalCount: 0,
    distribution: {}
  })
}));

vi.mock('../../services/publicFeedbackSubmit.service', () => ({
  getPublicFeedbackFormContext: vi.fn().mockResolvedValue({
    projectId: 'proj1',
    projectName: 'Dự án test',
    isAcceptingFeedback: true,
    submissionTicket: 'ticket-test'
  }),
  submitSingleFeedback: vi.fn()
}));

// Import SAU khi mock để đảm bảo mock được áp dụng
import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';
import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';
import {
  createPublicFeedbackClientIpSignature,
  PUBLIC_FEEDBACK_CLIENT_IP_HEADER,
  PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER
} from '../../utils/publicFeedbackClientIdentity';
import { __resetPublicFeedbackClientIpHmacKeyCacheForTests } from '../../config/publicFeedbackRuntimeConfig';
import { getMetricsRegistry, resetMetricsForTest } from '../../config/metricsRegistry';

function createTestApplication() {
  const testApplication = express();
  testApplication.set('trust proxy', 1);
  testApplication.use(express.json());
  testApplication.use('/api/feedback', createPublicFeedbackRoutes());
  return testApplication;
}

describe('publicFeedbackRoutes - rate limit (integration)', () => {
  // Reset rate limit store trước mỗi test để tránh pollution giữa các test case
  // do rateLimitStore là module-level singleton trong rateLimitMiddleware.ts
  beforeEach(() => {
    __resetRateLimitStore();
    resetMetricsForTest();
    mockWarn.mockClear();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'boundary-test-client-ip-hmac-key');
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
  });

  /** Tạo header giống Next.js SSR để kiểm tra boundary proxy không tin IP do browser tự gửi. */
  function signedClientIpHeaders(clientIp: string): Record<string, string> {
    return {
      [PUBLIC_FEEDBACK_CLIENT_IP_HEADER]: clientIp,
      [PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER]: createPublicFeedbackClientIpSignature(clientIp)
    };
  }

  it('trả về 429 khi vượt quá 30 requests/phút từ cùng IP', async () => {
    const testApplication = createTestApplication();

    // Gửi 30 requests hợp lệ - tất cả phải pass rate limit
    for (let requestIndex = 0; requestIndex < 30; requestIndex++) {
      const response = await request(testApplication).get('/api/feedback/public/proj1');
      expect(response.status).toBe(200);
    }

    // Request thứ 31 phải bị rate limit
    const blockedResponse = await request(testApplication).get('/api/feedback/public/proj1');
    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body.success).toBe(false);
    expect(blockedResponse.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('tách rate limit bucket giữa public và stats', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 30; requestIndex++) {
      await request(testApplication).get('/api/feedback/public/proj1');
    }

    const statsResponse = await request(testApplication).get('/api/feedback/stats/proj1');
    expect(statsResponse.status).toBe(200);
  });

  it('allows 60 invalid requests before limiting the single feedback bucket', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 60; requestIndex++) {
      const response = await request(testApplication).post('/api/feedback/single').send({});
      expect(response.status).toBe(400);
    }

    const blockedResponse = await request(testApplication).post('/api/feedback/single').send({});
    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('isolates rate-limit buckets by the trusted forwarded IP', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 30; requestIndex += 1) {
      await request(testApplication)
        .get('/api/feedback/public/proj1')
        .set('X-Forwarded-For', '203.0.113.10');
    }

    const firstIpBlockedResponse = await request(testApplication)
      .get('/api/feedback/public/proj1')
      .set('X-Forwarded-For', '203.0.113.10');
    const secondIpResponse = await request(testApplication)
      .get('/api/feedback/public/proj1')
      .set('X-Forwarded-For', '203.0.113.11');

    expect(firstIpBlockedResponse.status).toBe(429);
    expect(secondIpResponse.status).toBe(200);
  });

  it('isolates SSR form-context reads by the signed edge IP across the FE proxy boundary', async () => {
    const testApplication = createTestApplication();
    const firstIpHeaders = signedClientIpHeaders('203.0.113.20');
    const secondIpHeaders = signedClientIpHeaders('203.0.113.21');

    for (let requestIndex = 0; requestIndex < 60; requestIndex += 1) {
      await request(testApplication)
        .get('/api/feedback/form-context/proj1')
        .set(firstIpHeaders);
    }

    const firstIpBlockedResponse = await request(testApplication)
      .get('/api/feedback/form-context/proj1')
      .set(firstIpHeaders);
    const secondIpResponse = await request(testApplication)
      .get('/api/feedback/form-context/proj1')
      .set(secondIpHeaders);
    const forgedHeaderResponse = await request(testApplication)
      .get('/api/feedback/form-context/proj1')
      .set('X-Feedback-Client-IP', '203.0.113.20')
      .set('X-Feedback-Client-IP-Signature', 'forged-signature')
      .set('X-Forwarded-For', '203.0.113.22');

    expect(firstIpBlockedResponse.status).toBe(429);
    expect(secondIpResponse.status).not.toBe(429);
    expect(forgedHeaderResponse.status).not.toBe(429);
  });

  it('logs unverified identity for both SSR-only read routes', async () => {
    const testApplication = createTestApplication();

    const formContextResponse = await request(testApplication)
      .get('/api/feedback/form-context/proj1');
    const statsResponse = await request(testApplication)
      .get('/api/feedback/stats/proj1');
    const metrics = await getMetricsRegistry().metrics();

    expect(formContextResponse.status).toBe(200);
    expect(statsResponse.status).toBe(200);
    expect(metrics).toContain('public_feedback_client_identity_fallback_total{route="form-context"} 1');
    expect(metrics).toContain('public_feedback_client_identity_fallback_total{route="stats"} 1');
  });
});
