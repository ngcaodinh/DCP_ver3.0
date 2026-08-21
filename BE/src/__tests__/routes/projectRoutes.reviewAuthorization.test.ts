import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/authenticationMiddleware', () => ({ createAuthenticationMiddleware: () => (req: any, res: any, next: any) => { const role = req.header('x-role'); if (!role) return res.sendStatus(401); req.authenticatedUser = { userId: 'u', role }; next(); } }));
vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({ createRoleAuthorizationMiddleware: (roles: string[]) => (req: any, res: any, next: any) => roles.includes(req.authenticatedUser.role) ? next() : res.sendStatus(403) }));
vi.mock('../../middleware/ipMetadataMiddleware', () => ({ attachRequestMetadata: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../middleware/rateLimitMiddleware', () => ({ createRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../controllers/projectController', () => Object.fromEntries(['handleCreateProject', 'handleGetCreateProjectEligibility', 'handleGetOrganizationProjects', 'handleGetPendingApprovalProjects', 'handleGetProjectReviewHistory', 'handleGetPublicSupportProjectDetail', 'handleGetPublicSupportProjects', 'handleReviewProject', 'handleSubmitProject', 'handleUpdateProject', 'handleUploadProjectEvidences'].map(name => [name, (_req: any, res: any) => res.sendStatus(200)])));

import { createProjectRoutes } from '../../routes/projectRoutes';

/** Mount project router độc lập để xác minh admin không còn vào bất kỳ endpoint review nào. */
function app() { const instance = express(); instance.use(express.json()); instance.use('/api/projects', createProjectRoutes()); return instance; }

describe('project review authorization', () => {
  it.each([
    ['get', '/api/projects/pending-approval'], ['get', '/api/projects/review-history'], ['post', '/api/projects/review']
  ] as const)('rejects admin on %s %s', async (method, path) => {
    await request(app())[method](path).set('x-role', 'admin').send({}).expect(403);
  });

  it.each([
    ['get', '/api/projects/pending-approval'], ['get', '/api/projects/review-history'], ['post', '/api/projects/review']
  ] as const)('permits regulatory on %s %s', async (method, path) => {
    await request(app())[method](path).set('x-role', 'regulatory').send({}).expect(200);
  });
});
