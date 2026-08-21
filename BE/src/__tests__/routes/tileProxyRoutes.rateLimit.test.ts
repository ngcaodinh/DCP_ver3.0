/**
 * Integration test cho rate limit của public tile proxy route.
 * Controller được mock để kiểm tra middleware mà không gọi OpenStreetMap.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../controllers/tileProxyController', () => ({
  proxyMapTile: (_request: express.Request, response: express.Response): void => {
    response.status(200).send('tile');
  },
  proxyAdministrativeMapTile: (_request: express.Request, response: express.Response): void => {
    response.status(200).send('administrative-tile');
  }
}));

import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';
import { createTileProxyRoutes } from '../../routes/tileProxyRoutes';

/**
 * Tạo Express app tối giản để kiểm tra tile proxy router.
 * @returns Ứng dụng Express đã mount tile proxy route.
 */
function createTestApplication(): express.Express {
  const testApplication = express();
  testApplication.use('/api/tiles', createTileProxyRoutes());
  return testApplication;
}

describe('tileProxyRoutes - rate limit', () => {
  beforeEach(() => {
    __resetRateLimitStore();
  });

  it('trả 429 khi một IP vượt quá 120 tile requests mỗi phút', async () => {
    const testApplication = createTestApplication();

    for (let requestIndex = 0; requestIndex < 120; requestIndex++) {
      const response = await request(testApplication).get('/api/tiles/4/1/2.png');
      expect(response.status).toBe(200);
    }

    const blockedResponse = await request(testApplication).get('/api/tiles/4/1/2.png');

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body.success).toBe(false);
    expect(blockedResponse.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('định tuyến tile địa giới trước route tile nền tổng quát', async () => {
    const testApplication = createTestApplication();

    const response = await request(testApplication).get('/api/tiles/administrative/6/54/35.png');

    expect(response.status).toBe(200);
    expect(response.text).toBe('administrative-tile');
  });
});
