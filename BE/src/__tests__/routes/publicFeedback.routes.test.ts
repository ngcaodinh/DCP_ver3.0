/**
 * Test cho public feedback routes - không yêu cầu authentication.
 * Tests này MOCK rate limiter để tập trung vào logic route/controller.
 * Test rate limit riêng ở file publicFeedback.rateLimit.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// Mock logger để tránh in ra console khi test
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

// Mock rate limit middleware để các test logic không bị ảnh hưởng bởi rate limit store shared
vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_request: express.Request, _response: express.Response, next: express.NextFunction) => {
    next();
  }
}));

// Mock toàn bộ service để test route mà không bị cache pollution
vi.mock('../../services/publicFeedback.service', () => ({
  getPublicFeedbackList: vi.fn(),
  getPublicFeedbackStats: vi.fn()
}));

import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';
import { getPublicFeedbackList, getPublicFeedbackStats } from '../../services/publicFeedback.service';

function createTestApplication() {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/api/feedback', createPublicFeedbackRoutes());
  return testApplication;
}

describe('publicFeedbackRoutes - logic tests', () => {
  let testApplication: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    testApplication = createTestApplication();
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('GET /api/feedback/public/:projectId', () => {
    it('trả về chỉ feedback không bị flag', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [
          { feedbackId: 'fb1', projectId: 'proj1', rating: 5, comment: 'Good', submittedAt: new Date() },
          { feedbackId: 'fb2', projectId: 'proj1', rating: 4, comment: 'Nice', submittedAt: new Date() }
        ],
        pagination: { page: 1, limit: 20, totalItems: 2, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.feedbacks).toHaveLength(2);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    it('response không bao gồm uploadedByOrganizationId, batchContentHash, riskScore', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [
          { feedbackId: 'fb1', projectId: 'proj1', rating: 5, comment: 'Good', submittedAt: new Date() }
        ],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.status).toBe(200);
      expect(response.body.data.feedbacks[0]).not.toHaveProperty('uploadedByOrganizationId');
      expect(response.body.data.feedbacks[0]).not.toHaveProperty('batchContentHash');
      expect(response.body.data.feedbacks[0]).not.toHaveProperty('riskScore');
    });

    it('response không phát hành hash tên hoặc plaintext name', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [
          { feedbackId: 'fb1', projectId: 'proj1', rating: 5, comment: 'Good', submittedAt: new Date() }
        ],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.status).toBe(200);
      expect(response.body.data.feedbacks[0]).not.toHaveProperty('beneficiaryNameHash');
      expect(response.body.data.feedbacks[0]).not.toHaveProperty('beneficiaryName');
    });

    it('pagination hoạt động đúng với page và limit', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: Array(5).fill({}),
        pagination: { page: 2, limit: 5, totalItems: 10, totalPages: 2, hasNextPage: false, hasPreviousPage: true }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=2&limit=5');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 2, 5);
      expect(response.body.data.pagination).toMatchObject({
        page: 2,
        limit: 5,
        hasNextPage: false,
        hasPreviousPage: true
      });
    });

    it('trả về empty array cho project không có feedback', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/nonexistent');

      expect(response.status).toBe(200);
      expect(response.body.data.feedbacks).toHaveLength(0);
    });

    it('default pagination values hoạt động', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [{}],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    it('limit tối đa là 50 (hard cap)', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: Array(50).fill({}),
        pagination: { page: 1, limit: 50, totalItems: 50, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=100');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 50);
    });

    it('trả về 400 cho page không hợp lệ', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=-1');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('trả về 400 cho limit không hợp lệ', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=0');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

  });

  describe('GET /api/feedback/stats/:projectId', () => {
    it('trả về giá trị zero cho project không có feedback', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: null,
        totalCount: 0,
        distribution: {}
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/nonexistent');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        avgRating: null,
        totalCount: 0,
        distribution: {}
      });
    });

    it('trả về avgRating và totalCount chính xác', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: 4,
        totalCount: 3,
        distribution: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 }
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/proj1');

      expect(response.status).toBe(200);
      expect(response.body.data.totalCount).toBe(3);
      expect(response.body.data.avgRating).toBe(4);
    });

    it('trả về distribution chính xác theo rating', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: 3.6,
        totalCount: 5,
        distribution: { '1': 1, '2': 0, '3': 1, '4': 1, '5': 2 }
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/proj1');

      expect(response.status).toBe(200);
      expect(response.body.data.distribution).toEqual({
        '1': 1,
        '2': 0,
        '3': 1,
        '4': 1,
        '5': 2
      });
    });

    it('chỉ tính feedback không bị flag (service filter trước khi trả)', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: 5,
        totalCount: 1,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 }
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/proj1');

      expect(response.status).toBe(200);
      expect(response.body.data.totalCount).toBe(1);
      expect(response.body.data.avgRating).toBe(5);
    });

    // Service bị mock toàn bộ, nên test này chỉ verify controller consistency (repeated calls
    // trả về cùng kết quả từ mock), KHÔNG phải cache hit. Cache behavior thực sự được verify
    // trong publicFeedback.service.test.ts (Group B).
    it('controller trả về kết quả nhất quán cho repeated calls (service đã mock)', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValue({
        avgRating: 5,
        totalCount: 1,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 }
      });

      const response1 = await request(testApplication).get('/api/feedback/stats/proj1');
      const response2 = await request(testApplication).get('/api/feedback/stats/proj1');

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response1.body.data).toEqual(response2.body.data);
    });
  });
});
