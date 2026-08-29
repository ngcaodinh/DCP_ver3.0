/**
 * Integration tests cho oracle routes — kiểm tra auth + role middleware ở route layer.
 * Controller được mock để test chỉ tập trung vào RBAC, không chạm DB/service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const authModelMocks = vi.hoisted(() => ({
  findUserById: vi.fn()
}));

interface JsonResponse {
  status: (code: number) => JsonResponse;
  json: (body: unknown) => unknown;
}

const oracleControllerMocks = vi.hoisted(() => {
  const okHandler = (_request: unknown, response: JsonResponse): unknown => (
    response.status(200).json({ success: true, data: { overrideRequestId: 'req-001' } })
  );

  return {
    handleVerifyImage: vi.fn(okHandler),
    handleVerifyImageBatch: vi.fn(okHandler),
    handleGetGeofence: vi.fn(okHandler),
    handleUpsertGeofence: vi.fn(okHandler),
    handleGetOverrideRequestById: vi.fn(okHandler),
    handleGetPendingOverrides: vi.fn(okHandler),
    handleVoteOverrideRequest: vi.fn(okHandler)
  };
});

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (req: Request, _res: Response, next: NextFunction): void => {
    const authorizationHeader = req.headers.authorization;
    const token = typeof authorizationHeader === 'string'
      ? authorizationHeader.replace('Bearer ', '')
      : '';
    const roleByToken: Record<string, string> = {
      'test-token-admin': 'admin',
      'test-token-admin-stale': 'admin',
      'test-token-admin-demoted': 'admin',
      'test-token-regulatory': 'regulatory',
      'test-token-organization': 'organizations',
      'test-token-donor': 'donor'
    };
    const userIdByToken: Record<string, string> = {
      'test-token-admin-demoted': 'admin-demoted-1'
    };
    const role = roleByToken[token];
    if (role) {
      (req as unknown as { authenticatedUser?: { userId: string; role: string; authVersion: number } }).authenticatedUser = {
        userId: userIdByToken[token] ?? `${role}-1`,
        role,
        authVersion: token === 'test-token-admin-stale' ? 1 : 2
      };
    }
    next();
  }
}));

vi.mock('../../models/authModel', () => authModelMocks);

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_req: Request, _res: Response, next: NextFunction): void => next()
}));

vi.mock('../../controllers/oracleController', () => oracleControllerMocks);

vi.mock('../../routes/sbt-trigger.routes', async () => {
  const expressModule = await import('express');
  return {
    createSbtTriggerRoutes: () => expressModule.Router()
  };
});

import { createOracleRoutes } from '../../routes/oracleRoutes';

/** Tạo Express app tối giản để test routing/middleware của oracle routes. */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', createOracleRoutes());
  return app;
}

describe('oracleRoutes — override request detail RBAC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authModelMocks.findUserById.mockImplementation(async (userId: string) => ({
      id: userId,
      role: userId === 'admin-demoted-1'
        ? 'donor'
        : userId.startsWith('regulatory')
          ? 'regulatory'
          : userId.startsWith('organizations')
            ? 'organizations'
            : userId.startsWith('donor')
              ? 'donor'
              : 'admin',
      accountStatus: 'ACTIVE',
      authVersion: 2
    }));
  });

  it.each([
    ['admin', 'test-token-admin'],
    ['regulatory', 'test-token-regulatory']
  ])('[B3-security] %s được phép đọc detail snapshot', async (_role, token) => {
    const app = createTestApp();

    const response = await request(app)
      .get('/api/oracle/override-requests/req-001')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(oracleControllerMocks.handleGetOverrideRequestById).not.toHaveBeenCalled();
  });

  it.each([
    ['organization', 'test-token-organization'],
    ['donor', 'test-token-donor']
  ])('[B3-security] %s không được đọc detail snapshot', async (_role, token) => {
    const app = createTestApp();

    const response = await request(app)
      .get('/api/oracle/override-requests/req-001')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(oracleControllerMocks.handleGetOverrideRequestById).not.toHaveBeenCalled();
  });
});

describe('oracleRoutes — override vote fresh authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authModelMocks.findUserById.mockImplementation(async (userId: string) => ({
      id: userId,
      role: userId === 'admin-demoted-1'
        ? 'donor'
        : userId.startsWith('regulatory')
          ? 'regulatory'
          : userId.startsWith('organizations')
            ? 'organizations'
            : userId.startsWith('donor')
              ? 'donor'
              : 'admin',
      accountStatus: 'ACTIVE',
      authVersion: 2
    }));
  });

  it('cho phép commissioner có authVersion hiện tại vote qua route', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/oracle/override-requests/req-001/vote')
      .set('Authorization', 'Bearer test-token-admin')
      .send({ vote: 'APPROVE', reason: 'Reason đủ dài cho vote' });

    expect(response.status).toBe(404);
    expect(oracleControllerMocks.handleVoteOverrideRequest).not.toHaveBeenCalled();
  });

  it('chặn JWT stale trước khi gọi controller vote', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/oracle/override-requests/req-001/vote')
      .set('Authorization', 'Bearer test-token-admin-stale')
      .send({ vote: 'APPROVE', reason: 'Reason đủ dài cho vote' });

    expect(response.status).toBe(404);
    expect(oracleControllerMocks.handleVoteOverrideRequest).not.toHaveBeenCalled();
  });

  it('chặn commissioner đã bị demote trước khi gọi controller vote', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/oracle/override-requests/req-001/vote')
      .set('Authorization', 'Bearer test-token-admin-demoted')
      .send({ vote: 'APPROVE', reason: 'Reason đủ dài cho vote' });

    expect(response.status).toBe(404);
    expect(oracleControllerMocks.handleVoteOverrideRequest).not.toHaveBeenCalled();
  });
});

describe('oracleRoutes — geofence RBAC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['GET', (app: express.Express) => request(app).get('/api/oracle/geofence/proj-001'), 'handleGetGeofence'],
    ['POST', (app: express.Express) => request(app).post('/api/oracle/geofence/proj-001').send({ polygon: [] }), 'handleUpsertGeofence']
  ])('[B5-security] %s geofence yêu cầu authentication', async (_method, makeRequest, handlerName) => {
    const app = createTestApp();

    const response = await makeRequest(app);

    expect(response.status).toBe(401);
    expect(oracleControllerMocks[handlerName as keyof typeof oracleControllerMocks]).not.toHaveBeenCalled();
  });

  it.each([
    ['organization', 'test-token-organization'],
    ['admin', 'test-token-admin'],
    ['regulatory', 'test-token-regulatory']
  ])('[B5-security] %s được phép GET geofence theo route policy', async (_role, token) => {
    const app = createTestApp();

    const response = await request(app)
      .get('/api/oracle/geofence/proj-001')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(oracleControllerMocks.handleGetGeofence).toHaveBeenCalledTimes(1);
  });

  it('[B5-security] donor bị chặn trước khi gọi GET geofence controller', async () => {
    const app = createTestApp();

    const response = await request(app)
      .get('/api/oracle/geofence/proj-001')
      .set('Authorization', 'Bearer test-token-donor');

    expect(response.status).toBe(403);
    expect(oracleControllerMocks.handleGetGeofence).not.toHaveBeenCalled();
  });

  it('[B5-security] chỉ Organization được phép POST geofence theo route policy', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/oracle/geofence/proj-001')
      .set('Authorization', 'Bearer test-token-organization')
      .send({ polygon: [] });

    expect(response.status).toBe(200);
    expect(oracleControllerMocks.handleUpsertGeofence).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['admin', 'test-token-admin'],
    ['regulatory', 'test-token-regulatory'],
    ['donor', 'test-token-donor']
  ])('[B5-security] %s bị chặn trước khi gọi POST geofence controller', async (_role, token) => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/oracle/geofence/proj-001')
      .set('Authorization', `Bearer ${token}`)
      .send({ polygon: [] });

    expect(response.status).toBe(403);
    expect(oracleControllerMocks.handleUpsertGeofence).not.toHaveBeenCalled();
  });
});
