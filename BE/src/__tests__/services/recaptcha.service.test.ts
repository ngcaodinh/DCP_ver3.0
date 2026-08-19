import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch, mockWarn } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockWarn: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }))
}));

import { __resetFoundationKycRuntimeConfigForTests } from '../../config/foundationKycRuntimeConfig';
import { verifyRecaptchaToken } from '../../services/recaptcha.service';

/** Lưu snapshot env để test captcha không làm nhiễm cấu hình của test suite khác. */
function snapshotEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV,
    RECAPTCHA_ENABLED: process.env.RECAPTCHA_ENABLED,
    RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,
    RECAPTCHA_MIN_SCORE: process.env.RECAPTCHA_MIN_SCORE
  };
}

const originalEnvironment = snapshotEnvironment();

describe('recaptcha service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    process.env.NODE_ENV = 'test';
    process.env.RECAPTCHA_ENABLED = 'true';
    process.env.RECAPTCHA_SECRET_KEY = 'test-secret-key';
    process.env.RECAPTCHA_MIN_SCORE = '0.5';
    __resetFoundationKycRuntimeConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NODE_ENV = originalEnvironment.NODE_ENV;
    process.env.RECAPTCHA_ENABLED = originalEnvironment.RECAPTCHA_ENABLED;
    process.env.RECAPTCHA_SECRET_KEY = originalEnvironment.RECAPTCHA_SECRET_KEY;
    process.env.RECAPTCHA_MIN_SCORE = originalEnvironment.RECAPTCHA_MIN_SCORE;
    __resetFoundationKycRuntimeConfigForTests();
  });

  it('accepts a successful verdict with the expected action and score', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true, score: 0.9, action: 'foundation_kyc_submit' })
    });

    await expect(verifyRecaptchaToken('token', 'foundation_kyc_submit', '127.0.0.1'))
      .resolves.toEqual({ isVerified: true, score: 0.9 });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://www.google.com/recaptcha/api/siteverify',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([
    [{ success: true, score: 0.2, action: 'foundation_kyc_submit' }, 'LOW_SCORE'],
    [{ success: true, score: 0.9, action: 'other_action' }, 'ACTION_MISMATCH'],
    [{ success: false, score: 0.9, action: 'foundation_kyc_submit' }, 'REJECTED']
  ] as const)('rejects an unsafe Google verdict with reason %s', async (responseBody, expectedReason) => {
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(responseBody) });

    await expect(verifyRecaptchaToken('token', 'foundation_kyc_submit', '127.0.0.1'))
      .resolves.toEqual({ isVerified: false, reason: expectedReason });
  });

  it('fails closed when Google verification cannot be reached', async () => {
    mockFetch.mockRejectedValue(new Error('network unavailable'));

    await expect(verifyRecaptchaToken('token', 'foundation_kyc_submit', '127.0.0.1'))
      .resolves.toEqual({ isVerified: false, reason: 'NETWORK' });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('fails closed as misconfigured when the score threshold is invalid', async () => {
    process.env.RECAPTCHA_MIN_SCORE = 'invalid-score';
    __resetFoundationKycRuntimeConfigForTests();

    await expect(verifyRecaptchaToken('token', 'foundation_kyc_submit', '127.0.0.1'))
      .resolves.toEqual({ isVerified: false, reason: 'DISABLED_MISCONFIG' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows a development bypass only when captcha is explicitly disabled outside production', async () => {
    process.env.RECAPTCHA_ENABLED = 'false';
    __resetFoundationKycRuntimeConfigForTests();

    await expect(verifyRecaptchaToken('development-bypass', 'foundation_kyc_submit', '127.0.0.1'))
      .resolves.toEqual({ isVerified: true, score: 1 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });
});
