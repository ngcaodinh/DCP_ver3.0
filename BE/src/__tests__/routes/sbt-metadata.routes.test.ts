import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { ApplicationError } from '../../utils/applicationError';

const mocks = vi.hoisted(() => ({
  getList: vi.fn(),
  getDetail: vi.fn(),
  updateStatus: vi.fn()
}));

vi.mock('../../services/sbt-metadata.service', () => ({
  getSbtListByProject: mocks.getList,
  getSbtTokenDetail: mocks.getDetail,
  updateSbtStatus: mocks.updateStatus
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (request: Request, _response: Response, next: NextFunction): void => {
    const token = request.headers.authorization;
    if (token === 'Bearer admin-token') {
      (request as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
        userId: 'admin-1',
        role: 'admin'
      };
    } else if (token === 'Bearer donor-token') {
      (request as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
        userId: 'donor-1',
        role: 'donor'
      };
    }
    next();
  }
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: (allowedRoles: string[]) => (
    request: Request,
    response: Response,
    next: NextFunction
  ): void => {
    const user = (request as unknown as { authenticatedUser?: { role: string } }).authenticatedUser;
    if (!user) {
      response.status(401).json({ success: false, errorCode: 'UNAUTHENTICATED' });
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      response.status(403).json({ success: false, errorCode: 'FORBIDDEN' });
      return;
    }
    next();
  }
}));

import { createSbtMetadataRoutes } from '../../routes/sbt-metadata.routes';
import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sbt', createSbtMetadataRoutes());
  return app;
}

describe('sbt metadata routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetRateLimitStore();
    mocks.getList.mockResolvedValue({
      entries: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 }
    });
    mocks.getDetail.mockResolvedValue({
      onChainTokenId: 1,
      onChain: { tokenStatus: 'ACTIVE' },
      offChain: { projectId: 'p-1' },
      ipfsMetadata: {},
      ipfsError: null,
      cached: false
    });
    mocks.updateStatus.mockResolvedValue({
      tokenId: 1,
      newStatus: 'REVOKED',
      isIrreversible: true,
      transactionHash: '0xstatus',
      blockNumber: 123
    });
  });

  it('GET project returns the default limit of 20', async () => {
    const response = await supertest(createTestApp()).get('/api/sbt/project/p-1');

    expect(response.status).toBe(200);
    expect(response.body.data.pagination.limit).toBe(20);
    expect(mocks.getList).toHaveBeenCalledWith('p-1', 1, 20);
  });

  it('GET token returns on-chain and off-chain detail', async () => {
    const response = await supertest(createTestApp()).get('/api/sbt/token/1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      onChainTokenId: 1,
      onChain: { tokenStatus: 'ACTIVE' },
      offChain: { projectId: 'p-1' }
    });
  });

  it('GET token maps missing SBT to 404 and rejects invalid tokenId', async () => {
    mocks.getDetail.mockRejectedValue(new ApplicationError('SBT không tồn tại.', 404, 'NOT_FOUND'));
    const missingResponse = await supertest(createTestApp()).get('/api/sbt/token/999999');
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body.message).toBe('SBT không tồn tại.');

    const invalidResponse = await supertest(createTestApp()).get('/api/sbt/token/abc');
    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.body.errorCode).toBe('VALIDATION_ERROR');
    expect(mocks.getDetail).toHaveBeenCalledTimes(1);
  });

  it('limits public GET requests to 100 per minute per bucket', async () => {
    const app = createTestApp();
    let lastResponse;
    for (let index = 0; index < 101; index += 1) {
      lastResponse = await supertest(app).get('/api/sbt/project/p-1');
    }

    expect(lastResponse?.status).toBe(429);
    expect(lastResponse?.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('protects update-status with authentication and admin role', async () => {
    const app = createTestApp();
    const payload = { tokenId: 1, newStatus: 'REVOKED', reason: 'Evidence reused.' };

    const unauthenticated = await supertest(app).post('/api/sbt/update-status').send(payload);
    expect(unauthenticated.status).toBe(401);

    const donor = await supertest(app)
      .post('/api/sbt/update-status')
      .set('Authorization', 'Bearer donor-token')
      .send(payload);
    expect(donor.status).toBe(403);

    const admin = await supertest(app)
      .post('/api/sbt/update-status')
      .set('Authorization', 'Bearer admin-token')
      .send(payload);
    expect(admin.status).toBe(200);
    expect(mocks.updateStatus).toHaveBeenCalledWith(1, 'REVOKED', 'Evidence reused.', 'admin-1');
  });

  it('limits update-status to 20 requests per minute per bucket', async () => {
    const app = createTestApp();
    const payload = { tokenId: 1, newStatus: 'REVOKED', reason: 'Evidence reused.' };
    let lastResponse;

    for (let index = 0; index < 21; index += 1) {
      lastResponse = await supertest(app)
        .post('/api/sbt/update-status')
        .set('Authorization', 'Bearer admin-token')
        .send(payload);
    }

    expect(lastResponse?.status).toBe(429);
    expect(lastResponse?.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(mocks.updateStatus).toHaveBeenCalledTimes(20);
  });
});
