import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listAuditLogs: vi.fn() }));

vi.mock('../../services/audit-log.service', () => ({
  listAdminAuditLogs: mocks.listAuditLogs
}));

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: vi.fn(() => (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      res.status(401).json({ success: false, errorCode: 'UNAUTHENTICATED' });
      return;
    }
    req.authenticatedUser = {
      userId: req.headers.authorization === 'Bearer operator' ? 'operator-1' : 'admin-1',
      role: req.headers.authorization === 'Bearer operator' ? 'operator' : 'admin',
      authVersion: 1
    };
    next();
  })
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: vi.fn((allowedRoles: string[]) => (req: any, res: any, next: any) => {
    if (!allowedRoles.includes(req.authenticatedUser?.role)) {
      res.status(403).json({ success: false, errorCode: 'FORBIDDEN' });
      return;
    }
    next();
  })
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next())
}));

import { createAuditLogRoutes } from '../../routes/audit-log.routes';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-logs', createAuditLogRoutes());
  return app;
}

describe('audit-log API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAuditLogs.mockResolvedValue({ items: [], page: 2, limit: 10, total: 0, totalPages: 0 });
  });

  it('requires authentication and current admin role', async () => {
    const app = createTestApp();
    await request(app).get('/api/audit-logs').expect(401);
    await request(app).get('/api/audit-logs').set('Authorization', 'Bearer operator').expect(403);
    expect(mocks.listAuditLogs).not.toHaveBeenCalled();
  });

  it('validates query server-side and passes bounded filters to service', async () => {
    const app = createTestApp();
    await request(app)
      .get('/api/audit-logs?page=2&limit=10&actionType=MANUAL_REJECT&adminId=admin-1&from=2026-08-01&to=2026-08-12')
      .set('Authorization', 'Bearer admin')
      .expect(200);

    expect(mocks.listAuditLogs).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      actionType: 'MANUAL_REJECT',
      adminId: 'admin-1',
      from: '2026-08-01',
      to: '2026-08-12'
    });

    await request(app)
      .get('/api/audit-logs?limit=1000&actionType=NOT_A_CANONICAL_ACTION')
      .set('Authorization', 'Bearer admin')
      .expect(400);

    await request(app)
      .get('/api/audit-logs?from=not-a-date')
      .set('Authorization', 'Bearer admin')
      .expect(400);

    await request(app)
      .get('/api/audit-logs?from=2026-08-12&to=2026-08-11')
      .set('Authorization', 'Bearer admin')
      .expect(400);

    expect(mocks.listAuditLogs).toHaveBeenCalledTimes(1);
  });
});
