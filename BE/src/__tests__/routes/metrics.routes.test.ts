import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetMetricsForTest } from '../../config/metricsRegistry';
import { __resetRateLimitStore } from '../../middleware/rateLimitMiddleware';
import { createMetricsRoutes } from '../../routes/metrics.routes';

const METRICS_TEST_TOKEN = 'metrics-test-token-0123456789012345';
const originalMetricsToken = process.env.METRICS_AUTH_TOKEN;

/** Tạo app test chỉ mount endpoint Prometheus để cô lập auth và exposition format. */
function createMetricsRouteTestApp(): express.Express {
  const application = express();
  application.use(createMetricsRoutes());
  return application;
}

describe('GET /metrics', () => {
  beforeEach(() => {
    process.env.METRICS_AUTH_TOKEN = METRICS_TEST_TOKEN;
    resetMetricsForTest();
    __resetRateLimitStore();
  });

  afterAll(() => {
    if (originalMetricsToken === undefined) delete process.env.METRICS_AUTH_TOKEN;
    else process.env.METRICS_AUTH_TOKEN = originalMetricsToken;
  });

  it('rejects a request without bearer token', async () => {
    await request(createMetricsRouteTestApp())
      .get('/metrics')
      .expect(401);
  });

  it('rejects a request with an incorrect bearer token', async () => {
    await request(createMetricsRouteTestApp())
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  it('returns all registered metric groups in Prometheus format', async () => {
    const application = createMetricsRouteTestApp();
    const response = await request(application)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TEST_TOKEN}`)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(response.text).toContain('# HELP http_requests_total');
    expect(response.text).toContain('# HELP blockchain_transactions_total');
    expect(response.text).toContain('# HELP donation_events_total');
    expect(response.text).toContain('# HELP process_cpu_user_seconds_total');

    await request(application)
      .get('/metrics/')
      .set('Authorization', `Bearer ${METRICS_TEST_TOKEN}`)
      .expect(200);
  });

  it('rate-limits repeated scrape requests after 120 requests per minute', async () => {
    const application = createMetricsRouteTestApp();
    const scrapeRequest = () => request(application)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TEST_TOKEN}`);

    const allowedResponses = await Promise.all(
      Array.from({ length: 120 }, () => scrapeRequest())
    );

    expect(allowedResponses.every(response => response.status === 200)).toBe(true);
    await scrapeRequest().expect(429);
  });
});
