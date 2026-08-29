import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createRateLimitMiddleware: vi.fn() }));

/** Tạo handler thành công để test chỉ tập trung vào public/protected route wiring. */
function createOkHandler(): (request: Request, response: Response) => void {
  return (_request, response) => response.sendStatus(200);
}

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => (request: Request, response: Response, next: NextFunction): void => {
    if (!request.header('x-role')) {
      response.sendStatus(401);
      return;
    }
    next();
  }
}));
vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createFreshRoleAuthorizationMiddleware: () => (_request: Request, _response: Response, next: NextFunction): void => next()
}));
vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: mocks.createRateLimitMiddleware
}));
vi.mock('../../controllers/publicCommitteeGovernanceController', () => ({
  handleGetPublicCommitteeDecisions: createOkHandler(),
  handleGetPublicCommitteeGovernanceEvents: createOkHandler()
}));
vi.mock('../../controllers/governanceSeatController', () => ({
  handleConfirmGovernanceBootstrap: createOkHandler(),
  handleCreateGovernanceSeat: createOkHandler(),
  handleGetGovernanceBootstrapState: createOkHandler(),
  handleGetGovernanceSeats: createOkHandler(),
  handleSuspendGovernanceSeat: createOkHandler()
}));

import { createGovernanceSeatRoutes } from '../../routes/governanceSeatRoutes';

describe('public committee governance routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRateLimitMiddleware.mockImplementation(() => (_request: Request, _response: Response, next: NextFunction): void => next());
  });

  it('cho phép đọc event và decision công khai mà không cần JWT', async () => {
    const application = express();
    application.use('/api/governance', createGovernanceSeatRoutes());

    await request(application).get('/api/governance/public/events').expect(200);
    await request(application).get('/api/governance/public/decisions').expect(200);
  });

  it('giữ route quản trị ghế ở sau authentication và dùng bucket giới hạn public riêng', async () => {
    const application = express();
    application.use('/api/governance', createGovernanceSeatRoutes());

    await request(application).get('/api/governance/seats').expect(401);

    expect(mocks.createRateLimitMiddleware).toHaveBeenCalledWith(
      120,
      60 * 1000,
      { bucketName: 'public-committee-governance' }
    );
  });
});
