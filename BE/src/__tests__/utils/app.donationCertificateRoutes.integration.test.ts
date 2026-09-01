import { Router } from 'express';
import request from 'supertest';
import { afterEach, describe, it, vi } from 'vitest';

const routeModules: Array<[string, string]> = [
  ['../../routes/authRoutes', 'createAuthRoutes'],
  ['../../routes/healthRoutes', 'createHealthRoutes'],
  ['../../routes/metrics.routes', 'createMetricsRoutes'],
  ['../../routes/depositRoutes', 'createDepositRoutes'],
  ['../../routes/projectRoutes', 'createProjectRoutes'],
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
  ['../../routes/locationSearchRoutes', 'createLocationSearchRoutes'],
  ['../../routes/audit-log.routes', 'createAuditLogRoutes'],
  ['../../routes/trustScoreRoutes', 'createTrustScoreRoutes'],
  ['../../routes/projectGovernanceRoutes', 'createProjectGovernanceRoutes'],
  ['../../routes/governanceSeatRoutes', 'createGovernanceSeatRoutes'],
  ['../../routes/auditorOnboardingRoutes', 'createAuditorOnboardingRoutes']
];
const ROUTE_TEST_TIMEOUT_MS = 15_000;

/** Cô lập bootstrap khỏi database/RPC để chỉ kiểm tra hai prefix public của donation router. */
function mockApplicationRoutes(): void {
  for (const [modulePath, exportName] of routeModules) {
    vi.doMock(modulePath, () => ({ [exportName]: () => Router() }));
  }
}

describe('application donation certificate route aliases', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('giữ URL /donations cũ và expose alias /api/donations cho Next rewrite', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:3000');
    vi.resetModules();

    const certificateRouter = Router();
    certificateRouter.get('/certificates/:certificateId', (_request, response) => {
      response.status(200).json({ success: true });
    });
    vi.doMock('../../routes/donationRoutes', () => ({ createDonationRoutes: () => certificateRouter }));
    mockApplicationRoutes();

    const { default: application } = await import('../../app');

    await request(application).get('/donations/certificates/DCP-2026-0123456789ABCDEF0123456789ABCDEF').expect(200);
    await request(application).get('/api/donations/certificates/DCP-2026-0123456789ABCDEF0123456789ABCDEF').expect(200);
  }, ROUTE_TEST_TIMEOUT_MS);
});
