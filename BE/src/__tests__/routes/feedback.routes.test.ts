import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  moderation: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ success: true })),
  auth: vi.fn(() => (req: { headers: Record<string, string>; authenticatedUser?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    const authorization = req.headers.authorization;
    if (!authorization) return res.status(401).json({ success: false, errorCode: 'UNAUTHENTICATED' });
    req.authenticatedUser = { role: authorization === 'Bearer admin' ? 'admin' : 'operator' };
    next();
  }),
  freshRole: vi.fn((roles: string[]) => (req: { authenticatedUser?: { role?: string } }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (!roles.includes(req.authenticatedUser?.role ?? '')) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN' });
    next();
  }),
  rateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next())
}));

vi.mock('../../controllers/feedbackModerationController', () => ({ handleFeedbackModeration: mocks.moderation }));
vi.mock('../../controllers/feedbackBatchController', () => ({
  batchUploadFeedbackController: mocks.moderation,
  FEEDBACK_BATCH_RATE_LIMIT_CONFIG: { maxRequests: 10, windowMs: 60_000, bucketName: 'feedback' },
  MAX_BATCH_SIZE: 100,
  MAX_UPLOAD_SIZE_BYTES: 1_000_000
}));
vi.mock('../../middleware/authenticationMiddleware', () => ({ createAuthenticationMiddleware: mocks.auth }));
vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: mocks.freshRole,
  createRoleAuthorizationMiddleware: mocks.freshRole
}));
vi.mock('../../middleware/rateLimitMiddleware', () => ({ createRateLimitMiddleware: mocks.rateLimit }));

import { createFeedbackRoutes } from '../../routes/feedback.routes';

describe('feedback moderation route', () => {
  beforeEach(() => vi.clearAllMocks());

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/feedback', createFeedbackRoutes());
    return app;
  }

  it('requires authentication and fresh admin role', async () => {
    const app = createTestApp();
    await request(app).post('/api/feedback/f-1/flag').send({ reason: 'Valid moderation reason' }).expect(401);
    await request(app).post('/api/feedback/f-1/flag').set('Authorization', 'Bearer operator').send({ reason: 'Valid moderation reason' }).expect(403);
    expect(mocks.moderation).not.toHaveBeenCalled();
  });

  it('routes only canonical flag/unflag actions to moderation controller', async () => {
    const app = createTestApp();
    await request(app).post('/api/feedback/f-1/unflag').set('Authorization', 'Bearer admin').send({ reason: 'Evidence was reviewed' }).expect(200);
    expect(mocks.moderation).toHaveBeenCalledTimes(1);
    await request(app).post('/api/feedback/f-1/delete').set('Authorization', 'Bearer admin').send({ reason: 'Evidence was reviewed' }).expect(404);
  });
});
