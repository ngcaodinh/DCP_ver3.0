import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCacheHmacKey, signCachePayload, verifyCachePayload } from '../../utils/cacheIntegrity';

describe('cacheIntegrity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed in production when no cache or JWT secret is configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CACHE_HMAC_KEY', '');
    vi.stubEnv('JWT_SECRET', '');

    expect(() => getCacheHmacKey()).toThrow(/CACHE_HMAC_KEY/);
  });

  it('rejects a weak configured cache key in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CACHE_HMAC_KEY', 'too-short');
    vi.stubEnv('JWT_SECRET', '');

    expect(() => getCacheHmacKey()).toThrow(/at least 32 characters/);
  });

  it('uses the configured cache key and verifies tamper-free payloads', () => {
    vi.stubEnv('CACHE_HMAC_KEY', 'cache-secret-for-unit-tests');
    const signedPayload = signCachePayload('{"ok":true}', 'test:cache');

    expect(verifyCachePayload(signedPayload, 'test:cache')).toBe('{"ok":true}');
    expect(verifyCachePayload(signedPayload, 'other:cache')).toBeNull();
    expect(verifyCachePayload(`${signedPayload}tampered`, 'test:cache')).toBeNull();
  });
});
