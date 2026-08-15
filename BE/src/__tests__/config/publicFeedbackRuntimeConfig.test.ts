import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPublicFeedbackClientIpHmacKeyCacheForTests,
  DEVELOPMENT_CLIENT_IP_HMAC_KEY,
  getPublicFeedbackFrontendUrl,
  getPublicFeedbackClientIpHmacKey,
  getPublicFeedbackIpHashSalt,
  validatePublicFeedbackRuntimeConfig
} from '../../config/publicFeedbackRuntimeConfig';
import {
  createPublicFeedbackClientIpSignature,
  getPublicFeedbackClientIp
} from '../../utils/publicFeedbackClientIdentity';

const originalNodeEnvironment = process.env.NODE_ENV;
const originalFrontendUrl = process.env.FRONTEND_URL;
const originalIpHashSalt = process.env.FEEDBACK_IP_HASH_SALT;
const originalClientIpHmacKey = process.env.FEEDBACK_CLIENT_IP_HMAC_KEY;
const originalClientIpHmacKeyFile = process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE;

describe('publicFeedbackRuntimeConfig', () => {
  beforeEach(() => {
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
    process.env.NODE_ENV = 'test';
    delete process.env.FRONTEND_URL;
    delete process.env.FEEDBACK_IP_HASH_SALT;
    delete process.env.FEEDBACK_CLIENT_IP_HMAC_KEY;
    delete process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE;
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
    if (originalIpHashSalt === undefined) delete process.env.FEEDBACK_IP_HASH_SALT;
    else process.env.FEEDBACK_IP_HASH_SALT = originalIpHashSalt;
    if (originalClientIpHmacKey === undefined) delete process.env.FEEDBACK_CLIENT_IP_HMAC_KEY;
    else process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = originalClientIpHmacKey;
    if (originalClientIpHmacKeyFile === undefined) delete process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE;
    else process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE = originalClientIpHmacKeyFile;
  });

  it('keeps localhost defaults for local development only', () => {
    expect(getPublicFeedbackFrontendUrl()).toBe('http://localhost:3000');
    expect(getPublicFeedbackIpHashSalt()).toContain('dcp-feedback-ip-development');
    expect(() => validatePublicFeedbackRuntimeConfig()).not.toThrow();
  });

  it('fails fast when production feedback secrets or redirect origin are missing', () => {
    process.env.NODE_ENV = 'production';

    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError('FEEDBACK_IP_HASH_SALT is not configured in production.');

    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'b'.repeat(32);
    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError('FRONTEND_URL is not configured in production.');
  });

  it('rejects weak salts and unsafe frontend URLs in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_IP_HASH_SALT = 'too-short';
    process.env.FRONTEND_URL = 'https://dcp.example.com';

    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError('FEEDBACK_IP_HASH_SALT must be at least 32 characters');

    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'b'.repeat(32);
    process.env.FRONTEND_URL = 'javascript:alert(1)';
    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError('absolute HTTP(S) URL');

    process.env.FRONTEND_URL = 'https://dcp.example.com/feedback';
    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError('origin without credentials');
  });

  it('fails fast when the shared SSR identity key is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FRONTEND_URL = 'https://dcp.example.com';
    delete process.env.FEEDBACK_CLIENT_IP_HMAC_KEY;

    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError(
      'FEEDBACK_CLIENT_IP_HMAC_KEY is not configured in production.'
    );

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-feedback-identity-missing-'));
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE = path.join(temporaryDirectory, 'missing.key');
    try {
      expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError(
        'FEEDBACK_CLIENT_IP_HMAC_KEY_FILE cannot be read.'
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('accepts a valid production runtime contract and strips trailing slashes', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'b'.repeat(32);
    process.env.FRONTEND_URL = 'https://dcp.example.com///';

    expect(() => validatePublicFeedbackRuntimeConfig()).not.toThrow();
    expect(getPublicFeedbackFrontendUrl()).toBe('https://dcp.example.com');
  });

  it('uses the mounted shared secret file once when repeatedly verifying an identity', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-feedback-identity-'));
    const keyFilePath = path.join(temporaryDirectory, 'feedback-client-ip-hmac.key');
    const mountedKey = 'mounted-shared-feedback-key-which-is-long-enough';
    const clientIp = '203.0.113.50';
    fs.writeFileSync(keyFilePath, mountedKey);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE = keyFilePath;
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'different-env-key';
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    const signature = createPublicFeedbackClientIpSignature(clientIp);
    const feedbackRequest = {
      ip: '198.51.100.10',
      get: (headerName: string): string | undefined => {
        if (headerName === 'X-Feedback-Client-IP') return clientIp;
        if (headerName === 'X-Feedback-Client-IP-Signature') return signature;
        return undefined;
      }
    } as Parameters<typeof getPublicFeedbackClientIp>[0];

    try {
      expect(getPublicFeedbackClientIp(feedbackRequest)).toBe(clientIp);
      expect(getPublicFeedbackClientIp(feedbackRequest)).toBe(clientIp);
      expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      readFileSyncSpy.mockRestore();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects known placeholder secrets even when their length is valid', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_IP_HASH_SALT = 'CHANGE_ME_FEEDBACK_IP_HASH_SALT_MIN_32_CHARS';
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'b'.repeat(32);
    process.env.FRONTEND_URL = 'https://dcp.example.com';

    expect(() => getPublicFeedbackIpHashSalt()).toThrowError('production placeholder');

    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = 'CHANGE_ME_FEEDBACK_CLIENT_IP_HMAC_KEY_MIN_32_CHARS';
    expect(() => getPublicFeedbackClientIpHmacKey()).toThrowError('production placeholder');
  });

  it('rejects the development identity key in production even when it is long enough', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_IP_HASH_SALT = 'a'.repeat(32);
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = DEVELOPMENT_CLIENT_IP_HMAC_KEY;
    process.env.FRONTEND_URL = 'https://dcp.example.com';

    expect(() => validatePublicFeedbackRuntimeConfig()).toThrowError(
      'FEEDBACK_CLIENT_IP_HMAC_KEY must not use the development key.'
    );
  });

  it('verifies the shared golden vector without importing frontend code', () => {
    const goldenVector = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../test-fixtures/feedback-client-identity-golden.json'),
      'utf8'
    )) as { ip: string; key: string; timeBucket: number; signature: string };
    vi.useFakeTimers({ now: goldenVector.timeBucket * 5 * 60 * 1000 + 1_000 });
    process.env.FEEDBACK_CLIENT_IP_HMAC_KEY = goldenVector.key;
    const feedbackRequest = {
      ip: '198.51.100.10',
      get: (headerName: string): string | undefined => {
        if (headerName === 'X-Feedback-Client-IP') return goldenVector.ip;
        if (headerName === 'X-Feedback-Client-IP-Signature') return goldenVector.signature;
        return undefined;
      }
    } as Parameters<typeof getPublicFeedbackClientIp>[0];

    expect(getPublicFeedbackClientIp(feedbackRequest)).toBe(goldenVector.ip);
    vi.useRealTimers();
  });
});
