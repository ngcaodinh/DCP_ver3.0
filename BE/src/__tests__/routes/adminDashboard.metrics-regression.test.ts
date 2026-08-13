import express from 'express';
import jsonWebToken from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  getAdminDashboardMetrics: vi.fn(),
  getAdminDashboardAuditLogs: vi.fn(),
  getAdminDashboardTimelineEvents: vi.fn(),
  getAdminSystemErrorLogs: vi.fn(),
  getAdminGuestSessionSummary: vi.fn(),
  listAdminGuestSessions: vi.fn(),
  invalidateAdminGuestSession: vi.fn(),
  updateAdminSystemErrorLogReadState: vi.fn()
}));

vi.mock('../../services/adminDashboardService', () => ({
  getAdminDashboardMetrics: serviceMocks.getAdminDashboardMetrics,
  getAdminDashboardAuditLogs: serviceMocks.getAdminDashboardAuditLogs,
  getAdminDashboardTimelineEvents: serviceMocks.getAdminDashboardTimelineEvents,
  getAdminSystemErrorLogs: serviceMocks.getAdminSystemErrorLogs,
  getAdminGuestSessionSummary: serviceMocks.getAdminGuestSessionSummary,
  listAdminGuestSessions: serviceMocks.listAdminGuestSessions,
  invalidateAdminGuestSession: serviceMocks.invalidateAdminGuestSession,
  updateAdminSystemErrorLogReadState: serviceMocks.updateAdminSystemErrorLogReadState
}));

import { createAdminDashboardRoutes } from '../../routes/adminDashboardRoutes';

/** Tạo JWT đúng cấu hình hiện có để kiểm tra route admin cũ vẫn giữ auth và JSON response. */
function createAdminToken(): string {
  process.env.JWT_SECRET = 'admin-regression-secret';
  process.env.JWT_ISSUER = 'dcp-backend';
  process.env.JWT_AUDIENCE = 'dcp-users';
  process.env.JWT_ACCESS_EXPIRES_IN = '1h';
  process.env.JWT_REFRESH_EXPIRES_IN = '1d';

  return jsonWebToken.sign(
    { userId: 'admin-1', role: 'admin', authVersion: 1 },
    process.env.JWT_SECRET,
    { issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }
  );
}

/** Tạo app test chỉ mount dashboard router, không phụ thuộc database/service implementation. */
function createAdminDashboardTestApp(): express.Express {
  const application = express();
  application.use('/api/admin/dashboard', createAdminDashboardRoutes());
  return application;
}

describe('admin dashboard metrics regression', () => {
  const originalJwtEnvironment = {
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_AUDIENCE: process.env.JWT_AUDIENCE,
    JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN,
    JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN
  };

  beforeEach(() => {
    serviceMocks.getAdminDashboardMetrics.mockResolvedValue({ totalProjects: 3 });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalJwtEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('still requires JWT and returns the existing JSON response shape', async () => {
    const application = createAdminDashboardTestApp();
    const adminToken = createAdminToken();

    await request(application)
      .get('/api/admin/dashboard/metrics')
      .expect(401);

    const response = await request(application)
      .get('/api/admin/dashboard/metrics')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      data: { totalProjects: 3 }
    }));
    expect(serviceMocks.getAdminDashboardMetrics).toHaveBeenCalledTimes(1);
  });
});
