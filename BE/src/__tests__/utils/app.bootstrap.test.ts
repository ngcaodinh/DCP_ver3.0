import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import mongoose from 'mongoose';

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

describe('application bootstrap cache integrity', () => {
  afterEach(() => {
    // Xóa model Mongoose được nạp trong lần import app trước khi vi.resetModules() nạp lại module.
    mongoose.deleteModel(/.+/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fail-fast khi production thiếu cả CACHE_HMAC_KEY và JWT_SECRET', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CACHE_HMAC_KEY', '');
    vi.stubEnv('JWT_SECRET', '');

    // Cô lập bootstrap guard khỏi side effect của các route/queue khi import app.
    mockApplicationRoutes();

    // Import app là boundary khởi động thật; nếu wiring bị xóa, assertion này sẽ không còn fail.
    await expect(import('../../app')).rejects.toThrow(/CACHE_HMAC_KEY/);
  });

  it('fail-fast khi production thiếu METRICS_AUTH_TOKEN sau khi các secret bootstrap hợp lệ', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GUEST_JWT_SECRET', 'g'.repeat(32));
    vi.stubEnv('CACHE_HMAC_KEY', 'c'.repeat(32));
    vi.stubEnv('JWT_SECRET', 'j'.repeat(32));
    vi.stubEnv('METRICS_AUTH_TOKEN', '');
    mockApplicationRoutes();

    await expect(import('../../app')).rejects.toThrow(/METRICS_AUTH_TOKEN/);
  });
}, INTEGRATION_TEST_TIMEOUT_MS);
