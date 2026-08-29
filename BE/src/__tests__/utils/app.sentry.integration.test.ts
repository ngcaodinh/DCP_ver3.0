import { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportTerminalErrorMock = vi.hoisted(() => vi.fn());
const INTEGRATION_TEST_TIMEOUT_MS = 15_000;

vi.mock('../../utils/sentryReporter', () => ({
  reportTerminalError: (...args: unknown[]) => reportTerminalErrorMock(...args)
}));

const applicationRouteModules: Array<[string, string]> = [
  ['../../routes/authRoutes', 'createAuthRoutes'],
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

/** Cô lập app khỏi side effect của các route không liên quan tới error handler. */
function mockApplicationRoutes(): void {
  for (const [modulePath, exportName] of applicationRouteModules) {
    vi.doMock(modulePath, () => ({ [exportName]: () => Router() }));
  }
}

describe('app error handler — phân nhánh theo bảng E6', () => {
  beforeEach(() => {
    reportTerminalErrorMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    reportTerminalErrorMock.mockReset();
  });

  it('lỗi 5xx ghi qua reportTerminalError với errorSource http-5xx', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();

    const { handleApplicationError } = await import('../../app');
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handleApplicationError(new Error('terminal failure'), {} as Request, response, vi.fn());

    expect(reportTerminalErrorMock).toHaveBeenCalledWith(
      'Unhandled error in request',
      expect.any(Error),
      { errorSource: 'http-5xx' }
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'INTERNAL_ERROR'
    }));
  });

  it('413 payload too large chỉ vào Winston, không vào Sentry reporter', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUEST_BODY_LIMIT', '1kb');
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();

    const { default: application } = await import('../../app');
    const response = await request(application)
      .post('/unmatched')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(2 * 1024) });

    expect(response.status).toBe(413);
    expect(response.body.errorCode).toBe('PAYLOAD_TOO_LARGE');
    expect(reportTerminalErrorMock).not.toHaveBeenCalled();
  });
}, INTEGRATION_TEST_TIMEOUT_MS);
