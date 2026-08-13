import { afterEach, describe, expect, it } from 'vitest';
import { validateMetricsAuthConfig } from '../../config/metricsAuthConfig';

describe('validateMetricsAuthConfig', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMetricsToken = process.env.METRICS_AUTH_TOKEN;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalMetricsToken === undefined) {
      delete process.env.METRICS_AUTH_TOKEN;
    } else {
      process.env.METRICS_AUTH_TOKEN = originalMetricsToken;
    }
  });

  it('throws during production bootstrap when the token is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_AUTH_TOKEN;
    expect(() => validateMetricsAuthConfig()).toThrow('METRICS_AUTH_TOKEN');
  });

  it('allows development without a token', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.METRICS_AUTH_TOKEN;
    expect(() => validateMetricsAuthConfig()).not.toThrow();
  });

  it('fails closed in staging when the token is missing', () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.METRICS_AUTH_TOKEN;
    expect(() => validateMetricsAuthConfig()).toThrow('METRICS_AUTH_TOKEN');
  });

  it('rejects a configured token shorter than the minimum length', () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_AUTH_TOKEN = 'x'.repeat(31);

    expect(() => validateMetricsAuthConfig()).toThrow('at least 32 characters');
  });

  it('accepts a configured token at the exact minimum length', () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_AUTH_TOKEN = 'x'.repeat(32);

    expect(() => validateMetricsAuthConfig()).not.toThrow();
  });
});
