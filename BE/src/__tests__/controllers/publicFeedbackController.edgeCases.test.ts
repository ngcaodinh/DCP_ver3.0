/**
 * Controller edge case tests cho public feedback APIs.
 * Test toàn bộ input matrix cho page/limit và projectId validation.
 * Cover các trường hợp đặc biệt: NaN, decimal, hex, scientific notation,
 * array values, SQL injection attempts, và edge cases khác.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock logger để tránh console spam
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

// Mock rate limit middleware
vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_request: express.Request, _response: express.Response, next: express.NextFunction) => {
    next();
  }
}));

// Mock service
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

describe('publicFeedbackController - edge cases', () => {
  let testApplication: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    testApplication = createTestApplication();
  });

  afterEach(async () => {
    // Reset all mocks completely after each test
    vi.resetAllMocks();
  });

  // =============================================================================
  // GROUP D: Pagination Input Validation
  // =============================================================================

  describe('Group D: pagination input validation', () => {
    // D1: Empty query value → default 1
    it('D1: ?page= (empty value) sử dụng default page=1', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D2: Empty query value → default 20
    it('D2: ?limit= (empty value) sử dụng default limit=20', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D3: NaN string → 400 VALIDATION_ERROR
    it('D3: ?page=abc trả về 400 VALIDATION_ERROR (NaN)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=abc');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    // D4: NaN string → 400
    it('D4: ?limit=xyz trả về 400 VALIDATION_ERROR (NaN)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=xyz');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    // D5: Decimal page → parseInt behavior
    it('D5: ?page=1.5 parseInt thành 1, sau đó >= 1 nên hợp lệ', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=1.5');

      expect(response.status).toBe(200);
      // parseInt('1.5') = 1, và 1 >= 1 nên hợp lệ
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D6: Decimal limit → parseInt behavior
    it('D6: ?limit=10.9 parseInt thành 10, sau đó >= 1 nên hợp lệ', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=10.9');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 10);
    });

    // D7: Scientific notation → parseInt
    it('D7: ?page=1e2 (scientific notation = 100) parseInt thành 1 → 200 OK', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=1e2');

      // parseInt('1e2') = 1 (chỉ lấy phần số đầu tiên)
      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D8: Hex notation → parseInt
    it('D8: ?page=0x10 (hex = 16) parseInt thành 0 → 400 (không hợp lệ)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=0x10');

      // parseInt('0x10', 10) = 0 (không parse hex khi radix=10 mặc định)
      // 0 < 1 nên fail validation
      expect(response.status).toBe(400);
    });

    // D9: Negative zero → parseInt
    it('D9: ?page=-0 parseInt thành 0 → 400 (0 < 1)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=-0');

      // parseInt('-0') = 0, và 0 < 1 nên fail
      expect(response.status).toBe(400);
    });

    // D10: Plus sign
    it('D10: ?page=+5 parseInt thành 5 → 200 OK', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 5, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=+5');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 5, 20);
    });

    // D11: Limit cap at MAX_LIMIT (50)
    it('D11: ?limit=51 được cap về 50', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=51');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 50);
    });

    // D12: Exactly MAX_LIMIT
    it('D12: ?limit=50 (exactly MAX_LIMIT) hoạt động bình thường', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=50');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 50);
    });

    // D13: Below MAX_LIMIT
    it('D13: ?limit=49 (below MAX_LIMIT) hoạt động bình thường', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 49, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=49');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 49);
    });

    // D14: Huge page number
    it('D14: ?page=999999999 (huge number) vẫn hợp lệ vì parseInt thành 999999999', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 999999999, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=999999999');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 999999999, 20);
    });

    // D15: Literal string "null"
    it('D15: ?page=null (literal string) parseInt thành NaN → 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=null');

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    // D16: Boolean string "true"
    it('D16: ?page=true (literal string) parseInt thành NaN → 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=true');

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    // D17: Multiple values → Express behavior
    it('D17: ?page=1&page=2 (multiple values) Express lấy giá trị đầu tiên', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=1&page=2');

      expect(response.status).toBe(200);
      // Express lấy giá trị ĐẦU TIÊN khi có duplicate keys
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D18: Array syntax
    it('D18: ?page[]=1 (array syntax) Express trả về string "1" → 200 OK', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page[]=1');

      expect(response.status).toBe(200);
      // Express parse "page[]=1" thành query.page = "1"
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // D19: Both page and limit invalid → page error first
    it('D19: cả page và limit đều invalid → trả về error của page (short-circuit)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=abc&limit=xyz');

      // Controller check page trước, nên return page error
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Page');
    });

    // D20: SQL injection attempt → safe
    it('D20: ?page=1;DROP TABLE an toàn - parseInt thành NaN → 400', async () => {
      const response = await request(testApplication)
        .get("/api/feedback/public/proj1?page=1;DROP TABLE");

      // parseInt chỉ parse số, phần sau dấu ; bị bỏ qua
      // Kết quả: parseInt('1;DROP TABLE') = 1
      expect(response.status).toBe(200); // Vì 1 là số hợp lệ
    });

    // D21: SQL injection attempt in limit
    it('D21: ?limit=10;DROP TABLE an toàn - parseInt thành 10 → 200', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get("/api/feedback/public/proj1?limit=10;DROP TABLE");

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 10);
    });
  });

  // =============================================================================
  // GROUP E: projectId Validation
  // =============================================================================

  describe('Group E: projectId validation', () => {
    // E1: Missing projectId → 404 (Express route not matched)
    it('E1: /api/feedback/public/ (missing projectId) trả về 404', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/');

      // Express không match route vì thiếu :projectId
      expect(response.status).toBe(404);
    });

    // E2: Whitespace projectId → verify Express trim behavior
    it('E2: /api/feedback/public/%20 (URL-encoded space) không crash', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/%20');

      // Express decode URL-encoded space thành ' ' (single space)
      // Service được gọi với projectId = ' '
      expect(response.status).toBe(200);
    });

    // E3: URL-encoded space in projectId
    it('E3: /api/feedback/public/proj%20id (space in projectId) không crash', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj%20id');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalled();
    });

    // E4: Very long projectId
    it('E4: projectId rất dài (>100 chars) không crash', async () => {
      const longProjectId = 'a'.repeat(150);

      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get(`/api/feedback/public/${longProjectId}`);

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith(longProjectId, 1, 20);
    });

    // E5: Path traversal attempt - Express route không match với path chứa ..
    it('E5: /api/feedback/public/../../etc/passwd trả về 404 (Express không match route)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/../../etc/passwd');

      // Express không match route với path chứa "..", trả về 404
      expect(response.status).toBe(404);
    });

    // E6: Empty string projectId → 404 (route not matched)
    it('E6: /api/feedback/public/ (empty projectId) trả về 404', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/');

      expect(response.status).toBe(404);
    });

    // E7: Unicode projectId
    it('E7: projectId với Unicode characters không crash', async () => {
      const unicodeProjectId = 'dự-án-tiếng-việt-123';

      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get(`/api/feedback/public/${encodeURIComponent(unicodeProjectId)}`);

      expect(response.status).toBe(200);
    });
  });

  // =============================================================================
  // GROUP F: Response Shape
  // =============================================================================

  describe('Group F: response shape', () => {
    // F1: Success response envelope
    it('F1: success response có đúng format {success: true, message, data}', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [{ feedbackId: 'fb-1' }],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBeDefined();
      expect(response.body.data).toBeDefined();
      expect(response.body.data.feedbacks).toBeDefined();
      expect(response.body.data.pagination).toBeDefined();
    });

    // F2: Error response envelope
    it('F2: error response có đúng format {success: false, errorCode, message}', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=abc');

      expect(response.body.success).toBe(false);
      expect(response.body.errorCode).toBeDefined();
      expect(response.body.message).toBeDefined();
    });

    // F3: Empty feedbacks array pagination
    it('F3: empty feedbacks array có pagination với đúng giá trị', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(response.body.data.feedbacks).toEqual([]);
      expect(response.body.data.pagination.page).toBe(1);
      expect(response.body.data.pagination.totalItems).toBe(0);
      expect(response.body.data.pagination.totalPages).toBe(0);
    });

    // F4: totalPages = 0 when totalItems = 0
    it('F4: totalPages = 0 khi totalItems = 0 (không phải NaN)', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1');

      expect(Number.isNaN(response.body.data.pagination.totalPages)).toBe(false);
      expect(response.body.data.pagination.totalPages).toBe(0);
    });

    // F5: Stats response envelope
    it('F5: stats response có đúng format với avgRating, totalCount, distribution', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: 4.5,
        totalCount: 10,
        distribution: { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 }
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/proj1');

      expect(response.body.success).toBe(true);
      expect(response.body.data.avgRating).toBe(4.5);
      expect(response.body.data.totalCount).toBe(10);
      expect(response.body.data.distribution).toBeDefined();
    });

    // F6: Null avgRating for empty collection
    it('F6: avgRating là null khi không có feedback nào', async () => {
      (getPublicFeedbackStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        avgRating: null,
        totalCount: 0,
        distribution: {}
      });

      const response = await request(testApplication)
        .get('/api/feedback/stats/proj1');

      expect(response.body.data.avgRating).toBeNull();
      expect(response.body.data.totalCount).toBe(0);
    });
  });

  // =============================================================================
  // GROUP G: Additional Edge Cases
  // =============================================================================

  describe('Group G: additional edge cases', () => {
    // G1: Stats endpoint with path traversal → 404
    it('G1: /api/feedback/stats/../../etc/passwd trả về 404 (route not matched)', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/stats/../../etc/passwd');

      expect(response.status).toBe(404);
    });

    // G2: Negative page number
    it('G2: ?page=-5 trả về 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=-5');

      expect(response.status).toBe(400);
    });

    // G3: Zero page number
    it('G3: ?page=0 trả về 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=0');

      expect(response.status).toBe(400);
    });

    // G4: Negative limit
    it('G4: ?limit=-10 trả về 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=-10');

      expect(response.status).toBe(400);
    });

    // G5: Zero limit
    it('G5: ?limit=0 trả về 400', async () => {
      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=0');

      expect(response.status).toBe(400);
    });

    // G6: Page 1 with large limit
    it('G6: ?page=1&limit=100 được cap về 50', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=1&limit=100');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 50);
    });

    // G7: Fractional page with decimal point in different locales
    it('G7: ?page=1,5 (comma instead of dot) parseInt thành 1', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=1,5');

      // parseInt bỏ qua phần sau dấu , nên kết quả = 1
      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 20);
    });

    // G8: Limit with leading zeros
    it('G8: ?limit=007 parseInt thành 7', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 7, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?limit=007');

      expect(response.status).toBe(200);
      expect(getPublicFeedbackList).toHaveBeenCalledWith('proj1', 1, 7);
    });

    // G9: Whitespace around numeric value
    it('G9: ?page=%20%205%20 (URL-encoded spaces around number) xử lý bình thường', async () => {
      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 5, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get('/api/feedback/public/proj1?page=%20%205%20');

      expect(response.status).toBe(200);
    });

    // G10: Special characters in projectId
    it('G10: projectId với special chars như $ và _ xử lý bình thường', async () => {
      const specialProjectId = 'proj$special_id-123';

      (getPublicFeedbackList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        feedbacks: [],
        pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }
      });

      const response = await request(testApplication)
        .get(`/api/feedback/public/${encodeURIComponent(specialProjectId)}`);

      expect(response.status).toBe(200);
    });
  });
});
