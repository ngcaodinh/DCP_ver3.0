import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestHeaders = vi.hoisted(() => ({ value: new Headers() }));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => requestHeaders.value)
}));

import {
  CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS,
  __resetFeedbackClientIdentityWarningStateForTests,
  createFeedbackClientIdentityHeaders,
  getTrustedFeedbackClientIp
} from '@/app/feedback/[projectId]/feedbackClientIdentity';
import {
  __resetFeedbackClientIpHmacKeyCacheForTests,
  validateFeedbackClientIdentityConfig
} from '@/app/utils/feedbackClientIdentityConfig';

describe('feedbackClientIdentity', () => {
  beforeEach(() => {
    __resetFeedbackClientIpHmacKeyCacheForTests();
    __resetFeedbackClientIdentityWarningStateForTests();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'identity-test-client-ip-hmac-key');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE', '');
    requestHeaders.value = new Headers();
  });

  afterEach(() => {
    __resetFeedbackClientIpHmacKeyCacheForTests();
    __resetFeedbackClientIdentityWarningStateForTests();
    vi.unstubAllEnvs();
  });

  it('reads only a valid edge IP and signs the exact value for the backend', () => {
    requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': '203.0.113.50' });

    const clientIp = getTrustedFeedbackClientIp();
    const signedHeaders = createFeedbackClientIdentityHeaders(clientIp);
    const expectedSignature = crypto
      .createHmac('sha256', 'identity-test-client-ip-hmac-key')
      .update(
        `203.0.113.50|${Math.floor(Date.now() / CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS)}`,
        'utf8'
      )
      .digest('hex');

    expect(clientIp).toBe('203.0.113.50');
    expect(signedHeaders).toEqual({
      'X-Feedback-Client-IP': '203.0.113.50',
      'X-Feedback-Client-IP-Signature': expectedSignature
    });
  });

  it('does not sign an invalid or missing edge header', () => {
    requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': 'not-an-ip' });

    expect(getTrustedFeedbackClientIp()).toBeNull();
    expect(createFeedbackClientIdentityHeaders(null)).toEqual({});
  });

  it('warns once per minute in production when the edge identity header is missing or invalid', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.useFakeTimers({ now: 1_000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(getTrustedFeedbackClientIp()).toBeNull();
      requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': 'not-an-ip' });
      expect(getTrustedFeedbackClientIp()).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(getTrustedFeedbackClientIp()).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails closed when production has no shared identity key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', '');
    requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': '203.0.113.50' });

    expect(() => getTrustedFeedbackClientIp()).toThrowError('not configured in production');
  });

  it('fails fast during the Next Node bootstrap when the shared identity key is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', '');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE', '');

    expect(() => validateFeedbackClientIdentityConfig()).toThrowError('not configured in production');
  });

  it('rejects the development identity key in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'dcp-feedback-client-ip-development-key-rotate-me');

    expect(() => validateFeedbackClientIdentityConfig()).toThrowError('must not use the development key');
  });

  it('uses the mounted shared secret file once when signing repeatedly', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-feedback-identity-'));
    const keyFilePath = path.join(temporaryDirectory, 'feedback-client-ip-hmac.key');
    const mountedKey = 'mounted-shared-feedback-key-which-is-long-enough';
    const clientIp = '203.0.113.50';
    fs.writeFileSync(keyFilePath, mountedKey);
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE', keyFilePath);
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'different-env-key');
    requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': clientIp });
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    try {
      const signedHeaders = createFeedbackClientIdentityHeaders(getTrustedFeedbackClientIp());
      const repeatedSignedHeaders = createFeedbackClientIdentityHeaders(clientIp);
      const expectedSignature = crypto
        .createHmac('sha256', mountedKey)
        .update(`${clientIp}|${Math.floor(Date.now() / CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS)}`, 'utf8')
        .digest('hex');

      expect(signedHeaders['X-Feedback-Client-IP-Signature']).toBe(expectedSignature);
      expect(repeatedSignedHeaders['X-Feedback-Client-IP-Signature']).toBe(expectedSignature);
      expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      readFileSyncSpy.mockRestore();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('matches the shared golden vector without importing backend source', () => {
    const goldenVector = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../../test-fixtures/feedback-client-identity-golden.json'),
      'utf8'
    )) as { ip: string; key: string; timeBucket: number; signature: string };
    vi.useFakeTimers({ now: goldenVector.timeBucket * CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS + 1_000 });
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', goldenVector.key);
    requestHeaders.value = new Headers({ 'X-Feedback-Client-IP': goldenVector.ip });

    expect(createFeedbackClientIdentityHeaders(getTrustedFeedbackClientIp())).toEqual({
      'X-Feedback-Client-IP': goldenVector.ip,
      'X-Feedback-Client-IP-Signature': goldenVector.signature
    });
    vi.useRealTimers();
  });
});
