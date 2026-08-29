import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (req: any, _res: any, next: any) => {
    req.authenticatedUser = { userId: 'executive-user-1', role: req.header('x-role') };
    next();
  }
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: () => (_req: any, _res: any, next: any) => next()
}));

vi.mock('../../controllers/projectGovernanceController', () => ({
  handleGetAuditorActiveProjects: (_req: any, res: any) => res.sendStatus(200),
  handleGetAuditorFieldReport: (_req: any, res: any) => res.sendStatus(200),
  handleGetAuditorPendingProjects: (_req: any, res: any) => res.sendStatus(200),
  handleGetExecutiveActiveProjectDetail: (_req: any, res: any) => res.sendStatus(200),
  handleGetExecutiveActiveProjects: (_req: any, res: any) => res.sendStatus(200),
  handleGetExecutiveCaseDetail: (_req: any, res: any) => res.sendStatus(200),
  handleGetExecutiveCases: (_req: any, res: any) => res.sendStatus(200),
  handleGetMyAuditorFieldReports: (_req: any, res: any) => res.sendStatus(200),
  handleGetMyAuditorListingRecords: (_req: any, res: any) => res.sendStatus(200),
  handlePrepareArbitrationVoteSignature: (_req: any, res: any) => res.sendStatus(200),
  handleRecoverProjectArbitrationOnChainDecision: (_req: any, res: any) => res.sendStatus(200),
  handleRetryProjectActivation: (_req: any, res: any) => res.sendStatus(200),
  handleSubmitAuditorFieldReport: (_req: any, res: any) => res.sendStatus(201),
  handleSubmitAuditorListingVerification: (_req: any, res: any) => res.sendStatus(201),
  handleSubmitProjectChallenge: (_req: any, res: any) => res.sendStatus(201),
  handleUpdateMilestonePlan: (_req: any, res: any) => res.sendStatus(200),
  handleVoteOnArbitration: (_req: any, res: any) => res.sendStatus(200)
}));

import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';
import { createProjectGovernanceRoutes } from '../../routes/projectGovernanceRoutes';

/** Tạo app độc lập để kiểm tra rate limit trên chính middleware production. */
function createTestApplication() {
  const testApplication = express();
  testApplication.set('trust proxy', 1);
  testApplication.use(express.json());
  testApplication.use('/api/project-governance', createProjectGovernanceRoutes());
  return testApplication;
}

/** Gửi số request đủ vượt ngưỡng và trả response bị chặn cuối cùng. */
async function exhaustExecutiveArbitrationRateLimit(testApplication: express.Express, endpoint: string) {
  const clientIp = '203.0.113.60';

  for (let requestIndex = 0; requestIndex < 30; requestIndex += 1) {
    await request(testApplication)
      .post(endpoint)
      .set('x-role', 'executive_member')
      .set('X-Forwarded-For', clientIp)
      .expect(200);
  }

  return request(testApplication)
    .post(endpoint)
    .set('x-role', 'executive_member')
    .set('X-Forwarded-For', clientIp);
}

describe('projectGovernanceRoutes - executive arbitration rate limit', () => {
  beforeEach(() => {
    __resetRateLimitStore();
    vi.clearAllMocks();
  });

  it('giới hạn signing payload ở request thứ 31 nhưng không chặn bucket vote riêng', async () => {
    const testApplication = createTestApplication();

    const blockedResponse = await exhaustExecutiveArbitrationRateLimit(
      testApplication,
      '/api/project-governance/executive/signing-payload'
    );
    const voteResponse = await request(testApplication)
      .post('/api/project-governance/executive/vote')
      .set('x-role', 'executive_member')
      .set('X-Forwarded-For', '203.0.113.60');

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body).toMatchObject({ success: false, errorCode: 'RATE_LIMIT_EXCEEDED' });
    expect(voteResponse.status).toBe(200);
  });

  it('giới hạn vote ở request thứ 31 nhưng không chặn bucket signing payload riêng', async () => {
    const testApplication = createTestApplication();

    const blockedResponse = await exhaustExecutiveArbitrationRateLimit(
      testApplication,
      '/api/project-governance/executive/vote'
    );
    const signingPayloadResponse = await request(testApplication)
      .post('/api/project-governance/executive/signing-payload')
      .set('x-role', 'executive_member')
      .set('X-Forwarded-For', '203.0.113.60');

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.body).toMatchObject({ success: false, errorCode: 'RATE_LIMIT_EXCEEDED' });
    expect(signingPayloadResponse.status).toBe(200);
  });
});
