import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (requestObject: express.Request, _responseObject: express.Response, nextFunction: express.NextFunction) => {
    (requestObject as express.Request & { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
      userId: 'admin-1',
      role: 'admin'
    };
    nextFunction();
  },
  createOptionalAuthenticationMiddleware: () => (_requestObject: express.Request, _responseObject: express.Response, nextFunction: express.NextFunction) => {
    nextFunction();
  }
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createRoleAuthorizationMiddleware: () => (_requestObject: express.Request, _responseObject: express.Response, nextFunction: express.NextFunction) => {
    nextFunction();
  }
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_requestObject: express.Request, _responseObject: express.Response, nextFunction: express.NextFunction) => {
    nextFunction();
  }
}));

vi.mock('../../middleware/ipMetadataMiddleware', () => ({
  attachRequestMetadata: () => (_requestObject: express.Request, _responseObject: express.Response, nextFunction: express.NextFunction) => {
    nextFunction();
  }
}));

vi.mock('../../services/rankingService', () => ({
  recalculateRankingSnapshot: vi.fn(),
  getCurrentRankingSnapshotPaginated: vi.fn()
}));

vi.mock('../../services/rankingIncrementalService', () => ({
  getRankingFromIncrementalMetrics: vi.fn().mockResolvedValue([
    {
      projectId: 'P1',
      projectName: 'Project One',
      organizationName: 'Org 1',
      rankPosition: 1,
      totalRaisedAmount: 100,
      uniqueDonorCount: 5,
      quadraticScoreRaw: 10,
      matchingAmount: 0,
      totalFundingScore: 100
    }
  ])
}));

vi.mock('../../services/rankingCacheService', () => ({
  buildRankingCacheKey: vi.fn((key: string) => key),
  getRankingResponseCache: vi.fn().mockResolvedValue(null),
  invalidateRankingCache: vi.fn().mockResolvedValue(undefined),
  setRankingResponseCache: vi.fn().mockResolvedValue(undefined)
}));

import { createRankingRoutes } from '../../routes/rankingRoutes';

/** Hàm tạo app test cho ranking route. Mục đích: tái sử dụng cấu hình express trong các test case. */
function createTestApplication() {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/rankings', createRankingRoutes());
  return testApplication;
}

describe('rankingRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /rankings trả 400 khi sortBy không hợp lệ', async () => {
    const testApplication = createTestApplication();
    const response = await request(testApplication).get('/rankings?sortBy=unknown&sortDirection=asc');
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('GET /rankings trả dữ liệu thành công', async () => {
    const testApplication = createTestApplication();
    const response = await request(testApplication).get('/rankings?sortBy=rankPosition&sortDirection=asc');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].projectId).toBe('P1');
  }, 10000);

  it('POST /rankings/recalculate trả thành công cho admin', async () => {
    const testApplication = createTestApplication();
    const response = await request(testApplication).post('/rankings/recalculate').send({ windowHours: 12 });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
