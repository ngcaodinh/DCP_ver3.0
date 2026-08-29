import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import { Router, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticationMiddleware } from '../../middleware/authenticationMiddleware';
import { getRequestContext, getRequestId } from '../../config/requestContext';

const INTEGRATION_TEST_TIMEOUT_MS = 15_000;

const applicationRouteModules: ReadonlyArray<readonly [string, string]> = [
  ['../../routes/healthRoutes', 'createHealthRoutes'],
  ['../../routes/depositRoutes', 'createDepositRoutes'],
  ['../../routes/projectRoutes', 'createProjectRoutes'],
  ['../../routes/donationRoutes', 'createDonationRoutes'],
  ['../../routes/rankingRoutes', 'createRankingRoutes'],
  ['../../routes/sybilRoutes', 'createSybilRoutes'],
  ['../../routes/disbursementRoutes', 'createDisbursementRoutes'],
  ['../../routes/adminDashboardRoutes', 'createAdminDashboardRoutes'],
  ['../../routes/manualReviewRoutes', 'createManualReviewRoutes'],
  ['../../routes/notificationRoutes', 'createNotificationRoutes'],
  ['../../routes/oracleRoutes', 'createOracleRoutes'],
  ['../../routes/sbt.routes', 'createSbtRoutes'],
  ['../../routes/guestRoutes', 'createGuestRoutes'],
  ['../../routes/webhooks/payos.webhook', 'createPayosWebhookRoutes'],
  ['../../routes/transparencyRoutes', 'createTransparencyRoutes'],
  ['../../routes/verification.routes', 'createVerificationRoutes'],
  ['../../routes/feedback.routes', 'createFeedbackRoutes'],
  ['../../routes/public-feedback.routes', 'createPublicFeedbackRoutes'],
  ['../../routes/foundation-kyc.routes', 'createFoundationKycRoutes'],
  ['../../routes/tileProxyRoutes', 'createTileProxyRoutes'],
  ['../../routes/audit-log.routes', 'createAuditLogRoutes']
];

const authControllerHandlerNames = [
  'handleGetCurrentUserProfile',
  'handleGetFoundationOrganizationKycSubmissions',
  'handleGetMyActiveSessions',
  'handleGetMyOrganizationKycSubmissions',
  'handleGetMyOrganizationProfile',
  'handleGetPendingOrganizationKycSubmissions',
  'handleGoogleLogin',
  'handleLogoutAll',
  'handleOrganizationKycSubmission',
  'handleRefreshToken',
  'handleReviewOrganizationKycSubmission',
  'handleSubmitBeneficiaryBankAccount'
] as const;

/** Mock route factory không liên quan để import app.ts mà vẫn giữ auth middleware thật. */
function mockApplicationRoutes(): void {
  for (const [modulePath, exportName] of applicationRouteModules) {
    vi.doMock(modulePath, () => ({ [exportName]: () => Router() }));
  }
}

/** Mock controller auth để /auth route được mount thật mà không chạm database. */
function mockAuthController(): void {
  const handlers = Object.fromEntries(
    authControllerHandlerNames.map(handlerName => [handlerName, vi.fn()])
  );
  vi.doMock('../../controllers/authController', () => handlers);
}

describe('app.ts request context integration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('giữ userId null pre-auth, gắn userId sau JWT thật, và giữ null khi JWT sai', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUEST_BODY_LIMIT', '1kb');
    vi.stubEnv('JWT_SECRET', 'test-jwt-secret-for-request-context');
    vi.stubEnv('JWT_ISSUER', 'dcp-test');
    vi.stubEnv('JWT_AUDIENCE', 'dcp-users-test');
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '15m');
    vi.stubEnv('JWT_REFRESH_EXPIRES_IN', '7d');
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();
    mockAuthController();

    const { default: application } = await import('../../app');
    const observedUsers = new Map<string, string | null | undefined>();
    application.get('/__e6-context-probe', (_request: Request, response: Response) => {
      response.json(getRequestContext() ?? null);
    });
    application.get(
      '/__e6-protected-probe',
      (_request: Request, response: Response, next) => {
        const requestId = getRequestId();
        response.on('finish', () => {
          if (requestId) observedUsers.set(requestId, getRequestContext()?.userId ?? null);
        });
        next();
      },
      createAuthenticationMiddleware(),
      (_request: Request, response: Response) => {
        response.json(getRequestContext() ?? null);
      }
    );

    const unauthenticatedResponse = await request(application)
      .get('/__e6-context-probe')
      .set('X-Request-ID', 'pre-auth');
    expect(unauthenticatedResponse.body).toMatchObject({ requestId: 'pre-auth', userId: null });

    const validToken = jsonwebtoken.sign(
      { userId: 'user-e6', role: 'admin', authVersion: 1 },
      'test-jwt-secret-for-request-context',
      { issuer: 'dcp-test', audience: 'dcp-users-test', algorithm: 'HS256' }
    );
    const authenticatedResponse = await request(application)
      .get('/__e6-protected-probe')
      .set('X-Request-ID', 'valid-jwt')
      .set('Authorization', `Bearer ${validToken}`);
    expect(authenticatedResponse.body).toMatchObject({ requestId: 'valid-jwt', userId: 'user-e6' });

    const invalidResponse = await request(application)
      .get('/__e6-protected-probe')
      .set('X-Request-ID', 'invalid-jwt')
      .set('Authorization', 'Bearer invalid-token');
    expect(invalidResponse.status).toBe(401);
    expect(observedUsers.get('invalid-jwt')).toBeNull();
  }, 15_000);

  it('giữ request ID và correlation record cho CORS reject và lỗi 413', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUEST_BODY_LIMIT', '1kb');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://allowed.example');
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();
    mockAuthController();

    const { default: application } = await import('../../app');
    const { winstonLogger } = await import('../../utils/logger');
    const records: Record<string, unknown>[] = [];
    const listener = (record: Record<string, unknown>): void => {
      records.push(record);
    };
    winstonLogger.on('data', listener);
    application.post('/__e6-oversized-probe', (_request: Request, response: Response): void => {
      response.sendStatus(204);
    });

    try {
      const corsResponse = await request(application)
        .get('/__e6-context-probe')
        .set('Origin', 'https://evil.example')
        .set('X-Request-ID', 'cors-reject');
      expect(corsResponse.status).toBe(500);
      expect(corsResponse.headers['x-request-id']).toBe('cors-reject');

      const oversizedResponse = await request(application)
        .post('/__e6-oversized-probe')
        .set('Content-Type', 'application/json')
        .set('X-Request-ID', 'payload-too-large')
        .send({ payload: 'x'.repeat(2_048) });
      expect(oversizedResponse.status).toBe(413);
      expect(oversizedResponse.headers['x-request-id']).toBe('payload-too-large');

      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId: 'cors-reject', level: 'error' }),
        expect.objectContaining({ requestId: 'payload-too-large', level: 'error' })
      ]));
    } finally {
      winstonLogger.removeListener('data', listener);
    }
  });
}, INTEGRATION_TEST_TIMEOUT_MS);
