import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (req: any, _res: any, next: any) => { const role = req.header('x-role'); if (!role) { _res.status(401).json({ errorCode: 'UNAUTHENTICATED' }); return; } req.authenticatedUser = { userId: 'user-1', role }; next(); }
}));
vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createRoleAuthorizationMiddleware: (roles: string[]) => (req: any, res: any, next: any) => roles.includes(req.authenticatedUser.role) ? next() : res.status(403).json({ errorCode: 'FORBIDDEN' }),
  createFreshRoleAuthorizationMiddleware: (roles: string[]) => (req: any, res: any, next: any) => roles.includes(req.authenticatedUser.role) ? next() : res.status(403).json({ errorCode: 'FORBIDDEN' })
}));
vi.mock('../../middleware/rateLimitMiddleware', () => ({ createRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../controllers/projectGovernanceController', () => ({
  handleGetAuditorActiveProjects: (_req: any, res: any) => res.status(200).end(), handleGetAuditorFieldReport: (_req: any, res: any) => res.status(200).end(), handleGetAuditorPendingProjects: (_req: any, res: any) => res.status(200).end(), handleGetMyAuditorFieldReports: (_req: any, res: any) => res.status(200).end(), handleGetMyAuditorListingRecords: (_req: any, res: any) => res.status(200).end(), handleGetExecutiveActiveProjectDetail: (_req: any, res: any) => res.status(200).end(), handleGetExecutiveActiveProjects: (_req: any, res: any) => res.status(200).end(), handleGetExecutiveCases: (_req: any, res: any) => res.status(200).end(), handleGetExecutiveCaseDetail: (_req: any, res: any) => res.status(200).end(), handlePrepareArbitrationVoteSignature: (_req: any, res: any) => res.status(200).end(), handleRecoverProjectArbitrationOnChainDecision: (_req: any, res: any) => res.status(200).end(), handleRetryProjectActivation: (_req: any, res: any) => res.status(200).end(), handleSubmitAuditorFieldReport: (_req: any, res: any) => res.status(201).end(), handleSubmitAuditorListingVerification: (_req: any, res: any) => res.status(201).end(), handleSubmitProjectChallenge: (_req: any, res: any) => res.status(201).end(), handleUpdateMilestonePlan: (_req: any, res: any) => res.status(200).end(), handleVoteOnArbitration: (_req: any, res: any) => res.status(200).end()
}));

import { createProjectGovernanceRoutes } from '../../routes/projectGovernanceRoutes';

/** Tạo app nhỏ chỉ mount governance router để ma trận role không phụ thuộc app production. */
function app() { const instance = express(); instance.use(express.json()); instance.use('/api/project-governance', createProjectGovernanceRoutes()); return instance; }

describe('project governance route authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['donor', 'organizations', 'admin', 'regulatory', 'executive_chair', 'executive_member'])('rejects %s from auditor challenge', async role => {
    await request(app()).post('/api/project-governance/challenges').set('x-role', role).send({}).expect(403);
  });

  it('allows only auditor to submit a challenge and requires authentication', async () => {
    await request(app()).post('/api/project-governance/challenges').send({}).expect(401);
    await request(app()).post('/api/project-governance/challenges').set('x-role', 'auditor').send({}).expect(201);
  });

  it('requires authentication and auditor role for listing verification', async () => {
    await request(app()).post('/api/project-governance/auditor/listing-verification').send({}).expect(401);
    await request(app()).post('/api/project-governance/auditor/listing-verification').set('x-role', 'donor').send({}).expect(403);
    await request(app()).post('/api/project-governance/auditor/listing-verification').set('x-role', 'auditor').send({}).expect(201);
  });

  it.each(['executive_chair', 'executive_member'])('allows %s to vote', async role => {
    await request(app()).post('/api/project-governance/executive/vote').set('x-role', role).send({}).expect(200);
  });

  it.each(['auditor', 'admin', 'regulatory', 'organizations'])('rejects %s from executive vote', async role => {
    await request(app()).post('/api/project-governance/executive/vote').set('x-role', role).send({}).expect(403);
  });

  it.each(['executive_chair', 'admin'])('allows %s to retry failed activation', async role => {
    await request(app()).post('/api/project-governance/executive/retry-activation').set('x-role', role).send({}).expect(200);
  });

  it('rejects executive member from operational retry', async () => {
    await request(app()).post('/api/project-governance/executive/retry-activation').set('x-role', 'executive_member').send({}).expect(403);
  });

  it('chỉ cho admin gọi route khôi phục phán quyết xét xử on-chain', async () => {
    await request(app()).post('/api/project-governance/admin/executive/cases/ARB-1/recover-on-chain-decision').send({}).expect(401);
    await request(app()).post('/api/project-governance/admin/executive/cases/ARB-1/recover-on-chain-decision').set('x-role', 'executive_member').send({}).expect(403);
    await request(app()).post('/api/project-governance/admin/executive/cases/ARB-1/recover-on-chain-decision').set('x-role', 'admin').send({}).expect(200);
  });
});
