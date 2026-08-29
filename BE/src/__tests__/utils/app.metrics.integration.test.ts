import { Router } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  ['../../routes/auditorOnboardingRoutes', 'createAuditorOnboardingRoutes'],
  ['../../routes/webhooks/payos.webhook', 'createPayosWebhookRoutes'],
  ['../../routes/transparencyRoutes', 'createTransparencyRoutes'],
  ['../../routes/verification.routes', 'createVerificationRoutes'],
  ['../../routes/feedback.routes', 'createFeedbackRoutes'],
  ['../../routes/public-feedback.routes', 'createPublicFeedbackRoutes'],
  ['../../routes/tileProxyRoutes', 'createTileProxyRoutes']
];
const INTEGRATION_TEST_TIMEOUT_MS = 15_000;

/** Cô lập bootstrap app khỏi side effect của các route không liên quan đến regression metrics. */
function mockApplicationRoutes(): void {
  for (const [modulePath, exportName] of applicationRouteModules) {
    vi.doMock(modulePath, () => ({ [exportName]: () => Router() }));
  }
}

describe('application metrics integration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps metrics mounted before the JSON parser for oversized request bodies', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUEST_BODY_LIMIT', '1kb');
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();

    const { default: application } = await import('../../app');
    const { getMetricsRegistry, resetMetricsForTest } = await import('../../config/metricsRegistry');
    resetMetricsForTest();

    await request(application)
      .get('/metrics')
      .expect(200);

    const oversizedResponse = await request(application)
      .post('/unmatched')
      .set('Content-Type', 'application/json')
      .send({ payload: 'x'.repeat(2_048) })
      .expect(413);

    expect(oversizedResponse.body).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'PAYLOAD_TOO_LARGE'
    }));

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain(
      'http_requests_total{method="POST",route="unmatched",status_code="413"} 1'
    );
  });
}, INTEGRATION_TEST_TIMEOUT_MS);
