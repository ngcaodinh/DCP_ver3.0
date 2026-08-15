import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServerApiUrl, validateServerApiConfig } from '@/app/utils/serverApiClient';

describe('serverApiClient', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://backend:4000/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds an internal backend URL from the configured origin', () => {
    expect(buildServerApiUrl('/api/feedback/form-context/project-001')).toBe(
      'http://backend:4000/api/feedback/form-context/project-001'
    );
    expect(() => validateServerApiConfig()).not.toThrow();
  });

  it('fails fast in production when the internal backend URL is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BACKEND_INTERNAL_URL', '');

    expect(() => validateServerApiConfig()).toThrowError(
      'Thiếu cấu hình BACKEND_INTERNAL_URL trong môi trường production.'
    );
  });

  it.each([
    'backend:4000',
    'ftp://backend:4000',
    'http://backend:4000/api',
    'http://user:password@backend:4000',
    'http://backend:4000?source=feedback',
    'http://backend:4000#feedback'
  ])('rejects unsafe internal backend URL %s during startup validation', configuredUrl => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BACKEND_INTERNAL_URL', configuredUrl);

    expect(() => validateServerApiConfig()).toThrowError(
      'BACKEND_INTERNAL_URL must be an absolute HTTP(S) URL without credentials, path, query, or hash.'
    );
  });
});
