import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

type Handler = (request: Request, response: Response, next?: NextFunction) => unknown;

/** Tạo handler thành công để route test chỉ tập trung vào authentication và RBAC. */
function createOkHandler(): Handler {
  return (_request, response) => response.sendStatus(200);
}

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (request: Request, response: Response, next: NextFunction): void => {
    const role = request.header('x-role');
    if (!role) {
      response.sendStatus(401);
      return;
    }
    Object.assign(request, { authenticatedUser: { userId: `${role}-1`, role, authVersion: 1 } });
    next();
  }
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createRoleAuthorizationMiddleware: (allowedRoles: string[]) => (request: Request, response: Response, next: NextFunction): void => {
    const role = (request as Request & { authenticatedUser?: { role: string } }).authenticatedUser?.role;
    if (!role || !allowedRoles.includes(role)) {
      response.sendStatus(403);
      return;
    }
    next();
  },
  createFreshRoleAuthorizationMiddleware: (allowedRoles: string[]) => (request: Request, response: Response, next: NextFunction): void => {
    const role = (request as Request & { authenticatedUser?: { role: string } }).authenticatedUser?.role;
    if (!role || !allowedRoles.includes(role)) {
      response.sendStatus(403);
      return;
    }
    next();
  }
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_request: Request, _response: Response, next: NextFunction): void => next()
}));
vi.mock('../../middleware/ipMetadataMiddleware', () => ({
  attachRequestMetadata: () => (_request: Request, _response: Response, next: NextFunction): void => next()
}));

vi.mock('../../controllers/projectGovernanceController', () => ({
  handleGetAuditorActiveProjects: createOkHandler(),
  handleGetAuditorFieldReport: createOkHandler(),
  handleGetAuditorPendingProjects: createOkHandler(),
  handleGetMyAuditorFieldReports: createOkHandler(),
  handleGetMyAuditorListingRecords: createOkHandler(),
  handleGetExecutiveActiveProjectDetail: createOkHandler(),
  handleGetExecutiveActiveProjects: createOkHandler(),
  handleGetExecutivePendingPublicationProjectDetail: createOkHandler(),
  handleGetExecutivePendingPublicationProjects: createOkHandler(),
  handleGetExecutiveCaseDetail: createOkHandler(),
  handleGetExecutiveCases: createOkHandler(),
  handlePrepareArbitrationVoteSignature: createOkHandler(),
  handleRecoverProjectArbitrationOnChainDecision: createOkHandler(),
  handleRetryProjectActivation: createOkHandler(),
  handleSubmitAuditorFieldReport: createOkHandler(),
  handleSubmitAuditorListingVerification: createOkHandler(),
  handleSubmitProjectChallenge: createOkHandler(),
  handleUpdateMilestonePlan: createOkHandler(),
  handleVoteOnArbitration: createOkHandler()
}));
vi.mock('../../controllers/disbursementController', () => ({
  handleDisbursementTransferWebhook: createOkHandler(),
  handleDisbursementTransferWebhookHealth: createOkHandler(),
  handleCreateDisbursementRequest: createOkHandler(),
  handleGetMyDisbursements: createOkHandler(),
  handleGetDisbursementDetail: createOkHandler(),
  handleGetDisbursementsByProject: createOkHandler(),
  handleGetMaxWithdrawable: createOkHandler()
}));
vi.mock('../../controllers/disbursementCommitteeController', () => ({
  handleGetExecutivePendingDisbursements: createOkHandler(),
  handlePrepareDisbursementVoteSignature: createOkHandler(),
  handleRecoverDeadLetterDisbursementExecution: createOkHandler(),
  handleVoteOnDisbursement: createOkHandler()
}));
vi.mock('../../controllers/oracleController', () => ({
  handleGetGeofence: createOkHandler(),
  handleUpsertGeofence: createOkHandler()
}));
vi.mock('../../routes/sbt-trigger.routes', async () => {
  const expressModule = await import('express');
  return { createSbtTriggerRoutes: () => expressModule.Router() };
});

import { createDisbursementRoutes } from '../../routes/disbursementRoutes';
import { createOracleRoutes } from '../../routes/oracleRoutes';
import { createProjectGovernanceRoutes } from '../../routes/projectGovernanceRoutes';

/** Mount các router T3 tối thiểu để kiểm tra ma trận role mà không chạm database hoặc blockchain. */
function createTestApp(): express.Express {
  const application = express();
  application.use(express.json());
  application.use('/api/project-governance', createProjectGovernanceRoutes());
  application.use('/api/disbursement', createDisbursementRoutes());
  application.use('/api/oracle', createOracleRoutes());
  return application;
}

describe('executive committee route access', () => {
  it('chặn admin bỏ phiếu giải ngân nhưng cho Chair và Member đi qua', async () => {
    await request(createTestApp())
      .post('/api/disbursement/executive/request-1/vote')
      .set('x-role', 'admin')
      .send({ decision: 'APPROVE', reason: 'Một lý do hợp lệ.' })
      .expect(403);

    await request(createTestApp())
      .post('/api/disbursement/executive/request-1/vote')
      .set('x-role', 'executive_chair')
      .send({ decision: 'APPROVE', reason: 'Một lý do hợp lệ.' })
      .expect(200);

    await request(createTestApp())
      .post('/api/disbursement/executive/request-1/vote')
      .set('x-role', 'executive_member')
      .send({ decision: 'APPROVE', reason: 'Một lý do hợp lệ.' })
      .expect(200);
  });

  it.each(['donor', 'organizations', 'auditor', 'admin', 'regulatory'])('từ chối %s khỏi route vote giải ngân', async role => {
    await request(createTestApp())
      .post('/api/disbursement/executive/request-1/vote')
      .set('x-role', role)
      .send({ decision: 'APPROVE', reason: 'Một lý do hợp lệ.' })
      .expect(403);
  });

  it('chỉ cho admin gọi route khôi phục execution DEAD_LETTER', async () => {
    await request(createTestApp())
      .post('/api/disbursement/admin/executive/request-1/recover-execution')
      .set('x-role', 'executive_member')
      .send({ reason: 'Đã đối soát đầy đủ và cho phép worker chạy lại.' })
      .expect(403);

    await request(createTestApp())
      .post('/api/disbursement/admin/executive/request-1/recover-execution')
      .set('x-role', 'admin')
      .send({ reason: 'Đã đối soát đầy đủ và cho phép worker chạy lại.' })
      .expect(200);
  });

  it('chỉ cho admin gọi route khôi phục relay phán quyết xét xử', async () => {
    await request(createTestApp())
      .post('/api/project-governance/admin/executive/cases/arbitration-1/recover-on-chain-decision')
      .set('x-role', 'executive_chair')
      .send({ reason: 'Đã đối soát đầy đủ chữ ký và hạ tầng relay trước khi chạy lại.' })
      .expect(403);

    await request(createTestApp())
      .post('/api/project-governance/admin/executive/cases/arbitration-1/recover-on-chain-decision')
      .set('x-role', 'admin')
      .send({ reason: 'Đã đối soát đầy đủ chữ ký và hạ tầng relay trước khi chạy lại.' })
      .expect(200);
  });

  it.each([
    ['GET', '/api/project-governance/executive/active-projects'],
    ['GET', '/api/project-governance/executive/pending-activation-projects'],
    ['GET', '/api/project-governance/executive/cases'],
    ['POST', '/api/project-governance/executive/signing-payload'],
    ['GET', '/api/disbursement/executive/pending']
  ] as const)('cho phép role Ủy ban truy cập %s %s', async (method, path) => {
    const response = await request(createTestApp())
      [method === 'GET' ? 'get' : 'post'](path)
      .set('x-role', 'executive_member')
      .send({});

    expect(response.status).toBe(200);
  });

  it.each(['donor', 'organizations', 'auditor', 'admin', 'regulatory'])('từ chối %s khỏi hàng đợi dự án chờ công bố', async role => {
    await request(createTestApp())
      .get('/api/project-governance/executive/pending-activation-projects')
      .set('x-role', role)
      .expect(403);
  });

  it.each([
    ['POST', '/api/oracle/verify-image'],
    ['POST', '/api/oracle/verify-image/batch'],
    ['GET', '/api/oracle/pending-overrides'],
    ['GET', '/api/oracle/override-requests/request-1'],
    ['POST', '/api/oracle/override-requests/request-1/vote']
  ] as const)('giữ route ghi đè GPS đã khai tử ở trạng thái 404: %s %s', async (method, path) => {
    const response = await request(createTestApp())
      [method === 'GET' ? 'get' : 'post'](path)
      .set('x-role', 'admin')
      .send({});

    expect(response.status).toBe(404);
  });

  it('giữ route geofence cần thiết và không nhầm với route override đã gỡ', async () => {
    await request(createTestApp())
      .get('/api/oracle/geofence/project-1')
      .set('x-role', 'executive_member')
      .expect(403);

    await request(createTestApp())
      .get('/api/oracle/geofence/project-1')
      .set('x-role', 'admin')
      .expect(200);
  });
});
