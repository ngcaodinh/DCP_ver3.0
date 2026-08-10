import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';

describe('application bootstrap cache integrity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fail-fast khi production thiếu cả CACHE_HMAC_KEY và JWT_SECRET', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CACHE_HMAC_KEY', '');
    vi.stubEnv('JWT_SECRET', '');

    // Cô lập bootstrap guard khỏi side effect của các route/queue khi import app.
    const routeModules: Array<[string, string]> = [
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
      ['../../routes/tileProxyRoutes', 'createTileProxyRoutes']
    ];
    for (const [modulePath, exportName] of routeModules) {
      vi.doMock(modulePath, () => ({ [exportName]: () => Router() }));
    }

    // Import app là boundary khởi động thật; nếu wiring bị xóa, assertion này sẽ không còn fail.
    await expect(import('../../app')).rejects.toThrow(/CACHE_HMAC_KEY/);
  });
});
