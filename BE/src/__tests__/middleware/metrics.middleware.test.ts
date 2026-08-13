import express, { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMetricsRegistry,
  resetMetricsForTest
} from '../../config/metricsRegistry';
import { metricsMiddleware } from '../../middleware/metrics.middleware';

/** Tạo Express app nhỏ có route động để kiểm tra label route pattern và route unmatched. */
function createMetricsTestApp(): express.Express {
  const application = express();
  const donationRouter = express.Router();

  donationRouter.get('/campaigns/:projectId', (_request: Request, response: Response) => {
    response.status(200).send('ok');
  });

  const rankingRouter = express.Router();
  rankingRouter.get('/', (_request: Request, response: Response) => {
    response.status(200).send('rankings');
  });

  application.use(metricsMiddleware);
  application.use('/donations', donationRouter);
  application.use('/rankings', rankingRouter);
  application.get('/metrics', (_request: Request, response: Response) => {
    response.status(200).send('metrics');
  });
  application.get('/live', (_request: Request, response: Response) => {
    response.status(200).send('live');
  });

  return application;
}

describe('metricsMiddleware', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('records duration and count with the mounted route pattern', async () => {
    const application = createMetricsTestApp();

    await request(application)
      .get('/donations/campaigns/abc123')
      .expect(200);

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain(
      'http_requests_total{method="GET",route="/donations/campaigns/:projectId",status_code="200"} 1'
    );
    expect(metrics).toContain(
      'http_request_duration_seconds_count{method="GET",route="/donations/campaigns/:projectId",status_code="200"} 1'
    );
  });

  it('uses unmatched instead of the real path for an unknown route', async () => {
    const application = createMetricsTestApp();

    await request(application)
      .get('/scanner/.env-2026-08-13')
      .expect(404);

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain('http_requests_total{method="GET",route="unmatched",status_code="404"} 1');
    expect(metrics).not.toContain('/scanner/.env-2026-08-13');
  });

  it('uses the mounted base path when the router route is root', async () => {
    const application = createMetricsTestApp();

    await request(application)
      .get('/rankings')
      .expect(200);

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain(
      'http_requests_total{method="GET",route="/rankings",status_code="200"} 1'
    );
  });

  it('does not count metrics scraping and liveness probe requests', async () => {
    const application = createMetricsTestApp();

    await request(application).get('/metrics').expect(200);
    await request(application).get('/metrics/').expect(200);
    await request(application).get('/live').expect(200);

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).not.toContain('route="/metrics"');
    expect(metrics).not.toContain('route="/live"');
  });
});
