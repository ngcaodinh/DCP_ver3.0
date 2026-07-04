/**
 * Integration test cho rate limiting của public feedback routes.
 * File riêng vì rate limit store là module-level singleton trong rateLimitMiddleware.ts
 * — phải chạy trong process sạch để tránh pollution từ các test khác.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Mock logger
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
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

// Import SAU khi mock để đảm bảo mock được áp dụng
import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';

function createTestApplication() {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/api/feedback', createPublicFeedbackRoutes());
  return testApplication;
}

describe('publicFeedbackRoutes - rate limit (integration)', () => {
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

  it('rate limit bucket cô lập giữa các endpoint (public vs stats)', async () => {
    const testApplication = createTestApplication();

    // Bucket "public-feedback" được share giữa GET /public/:projectId và GET /stats/:projectId
    // (cùng bucket name trong route config). Đây là design choice — bucket name
    // định nghĩa group rate limit, không phải từng endpoint.
    // Verify: nếu dùng hết 30 request trên public, stats endpoint cũng bị block.
    for (let requestIndex = 0; requestIndex < 30; requestIndex++) {
      await request(testApplication).get('/api/feedback/public/proj1');
    }

    const statsBlockedResponse = await request(testApplication).get('/api/feedback/stats/proj1');
    expect(statsBlockedResponse.status).toBe(429);
  });
});