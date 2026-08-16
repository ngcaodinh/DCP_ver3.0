import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  organizationFeedback: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ route: 'organization' })),
  singleFeedback: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ route: 'single' })),
  formContext: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ route: 'form-context' })),
  publicList: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ route: 'public' })),
  publicStats: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => res.status(200).json({ route: 'stats' })),
  auth: vi.fn(() => (req: { headers: Record<string, string>; authenticatedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authenticatedUser = { userId: 'test-user', role: 'organizations' };
    next();
  }),
  freshRole: vi.fn((_roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next()),
  rateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next())
}));

vi.mock('../../controllers/organizationFeedbackController', () => ({
  handleListOrganizationFeedback: mocks.organizationFeedback
}));
vi.mock('../../controllers/publicFeedbackController', () => ({
  getPublicFeedbackListController: mocks.publicList,
  getPublicFeedbackStatsController: mocks.publicStats
}));
vi.mock('../../controllers/publicFeedbackSubmitController', () => ({
  getFeedbackFormContextController: mocks.formContext,
  submitSingleFeedbackController: mocks.singleFeedback
}));
vi.mock('../../controllers/feedbackBatchController', () => ({
  batchUploadFeedbackController: mocks.singleFeedback,
  FEEDBACK_BATCH_RATE_LIMIT_CONFIG: { maxRequests: 10, windowMs: 60_000, bucketName: 'feedback' },
  MAX_BATCH_SIZE: 100,
  MAX_UPLOAD_SIZE_BYTES: 1_000_000
}));
vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: mocks.auth
}));
vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: mocks.freshRole
}));
vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: mocks.rateLimit
}));

import { createFeedbackRoutes } from '../../routes/feedback.routes';
import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';

describe('feedback route composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('giữ nguyên public routes khi organization router được mount trước', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/feedback', createFeedbackRoutes());
    app.use('/api/feedback', createPublicFeedbackRoutes());

    await request(app)
      .get('/api/feedback/organization')
      .set('Authorization', 'Bearer organizations')
      .expect(200);
    await request(app).post('/api/feedback/single').send({}).expect(200);
    await request(app).get('/api/feedback/form-context/DA-001').expect(200);
    await request(app).get('/api/feedback/public/DA-001').expect(200);
    await request(app).get('/api/feedback/stats/DA-001').expect(200);

    expect(mocks.organizationFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.singleFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.formContext).toHaveBeenCalledTimes(1);
    expect(mocks.publicList).toHaveBeenCalledTimes(1);
    expect(mocks.publicStats).toHaveBeenCalledTimes(1);
  });
});
