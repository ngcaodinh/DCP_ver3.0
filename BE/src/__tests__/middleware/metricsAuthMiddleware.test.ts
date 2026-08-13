import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalNodeEnv = process.env.NODE_ENV;
const originalMetricsToken = process.env.METRICS_AUTH_TOKEN;

function restoreMetricsEnvironment(): void {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

  if (originalMetricsToken === undefined) delete process.env.METRICS_AUTH_TOKEN;
  else process.env.METRICS_AUTH_TOKEN = originalMetricsToken;
}

describe('metrics auth middleware configuration', () => {
  afterEach(() => {
    restoreMetricsEnvironment();
    vi.resetModules();
  });

  it('bypasses auth only in development when the token is missing', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.METRICS_AUTH_TOKEN;
    vi.resetModules();

    const { createMetricsAuthMiddleware } = await import('../../middleware/metricsAuthMiddleware');
    const application = express();
    application.get('/metrics', createMetricsAuthMiddleware(), (_request, response) => {
      response.status(200).send('ok');
    });

    await request(application).get('/metrics').expect(200, 'ok');
  });

  it('fails closed outside development/test when the token is missing', async () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.METRICS_AUTH_TOKEN;
    vi.resetModules();

    const { createMetricsAuthMiddleware } = await import('../../middleware/metricsAuthMiddleware');
    const application = express();
    application.get('/metrics', createMetricsAuthMiddleware(), (_request, response) => {
      response.status(200).send('ok');
    });

    const response = await request(application).get('/metrics').expect(401);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'UNAUTHENTICATED'
    }));
  });

  it('rejects a runtime token that violates the minimum length policy', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_AUTH_TOKEN = 'short-token';
    vi.resetModules();

    const { createMetricsAuthMiddleware } = await import('../../middleware/metricsAuthMiddleware');
    const application = express();
    application.get('/metrics', createMetricsAuthMiddleware(), (_request, response) => {
      response.status(200).send('ok');
    });

    const response = await request(application)
      .get('/metrics')
      .set('Authorization', 'Bearer short-token')
      .expect(401);

    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'UNAUTHENTICATED'
    }));
  });
});
