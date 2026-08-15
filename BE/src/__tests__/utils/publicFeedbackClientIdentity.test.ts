import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ warn: mockWarn }))
}));

import { __resetPublicFeedbackClientIpHmacKeyCacheForTests } from '../../config/publicFeedbackRuntimeConfig';
import {
  __resetPublicFeedbackClientIdentityWarningStateForTests,
  createPublicFeedbackClientIpSignature,
  PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS,
  verifyPublicFeedbackClientIp
} from '../../utils/publicFeedbackClientIdentity';

/** Tạo request tối thiểu để kiểm tra verifier mà không cần khởi tạo Express. */
function createFeedbackRequest(
  headers: Record<string, string>,
  requestIp = '198.51.100.10'
): Parameters<typeof verifyPublicFeedbackClientIp>[0] {
  return {
    ip: requestIp,
    get: (headerName: string): string | undefined => headers[headerName]
  } as Parameters<typeof verifyPublicFeedbackClientIp>[0];
}

describe('publicFeedbackClientIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'identity-test-client-ip-hmac-key');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE', '');
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
    __resetPublicFeedbackClientIdentityWarningStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
    __resetPublicFeedbackClientIdentityWarningStateForTests();
  });

  it('accepts a signature from the previous bucket at a bucket boundary', () => {
    const baseTimeMilliseconds = new Date('2026-08-15T12:00:00.000Z').getTime();
    const clientIp = '203.0.113.60';
    vi.setSystemTime(baseTimeMilliseconds);
    const signature = createPublicFeedbackClientIpSignature(clientIp, Date.now());

    vi.setSystemTime(baseTimeMilliseconds + PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS);

    expect(verifyPublicFeedbackClientIp(createFeedbackRequest({
      'X-Feedback-Client-IP': clientIp,
      'X-Feedback-Client-IP-Signature': signature
    }))).toEqual({ clientIp, isVerified: true });

    const futureBucketSignature = createPublicFeedbackClientIpSignature(
      clientIp,
      baseTimeMilliseconds + PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS
    );
    vi.setSystemTime(baseTimeMilliseconds);
    expect(verifyPublicFeedbackClientIp(createFeedbackRequest({
      'X-Feedback-Client-IP': clientIp,
      'X-Feedback-Client-IP-Signature': futureBucketSignature
    }))).toEqual({ clientIp, isVerified: true });
  });

  it('rejects a signature older than one previous bucket and falls back to request IP', () => {
    const baseTimeMilliseconds = new Date('2026-08-15T12:00:00.000Z').getTime();
    const clientIp = '203.0.113.60';
    const requestIp = '198.51.100.10';
    vi.setSystemTime(baseTimeMilliseconds);
    const signature = createPublicFeedbackClientIpSignature(clientIp, Date.now());

    vi.setSystemTime(baseTimeMilliseconds + 2 * PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS);

    expect(verifyPublicFeedbackClientIp(createFeedbackRequest({
      'X-Feedback-Client-IP': clientIp,
      'X-Feedback-Client-IP-Signature': signature
    }, requestIp))).toEqual({ clientIp: requestIp, isVerified: false });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('warns only for malformed identity headers and not for ordinary requests without them', () => {
    const invalidRequest = createFeedbackRequest({
      'X-Feedback-Client-IP': 'not-an-ip',
      'X-Feedback-Client-IP-Signature': 'invalid'
    });
    const ordinaryRequest = createFeedbackRequest({});

    expect(verifyPublicFeedbackClientIp(invalidRequest).isVerified).toBe(false);
    expect(verifyPublicFeedbackClientIp(ordinaryRequest).isVerified).toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
