import { getLogger } from '../config/logger';
import {
  getRecaptchaMinimumScore,
  getRecaptchaSecretKey,
  isRecaptchaVerificationEnabled
} from '../config/foundationKycRuntimeConfig';

const RECAPTCHA_VERIFY_ENDPOINT = 'https://www.google.com/recaptcha/api/siteverify';
const logger = getLogger();

export type RecaptchaVerdict =
  | { isVerified: true; score: number }
  | { isVerified: false; reason: 'DISABLED_MISCONFIG' | 'NETWORK' | 'LOW_SCORE' | 'ACTION_MISMATCH' | 'REJECTED' };

type RecaptchaApiResponse = {
  success?: boolean;
  score?: number;
  action?: string;
};

/**
 * Xác minh token reCAPTCHA v3 với Google và fail-closed khi mạng hoặc verdict không hợp lệ.
 * @param token Token do trình duyệt lấy ngay trước khi submit.
 * @param expectedAction Action cố định của flow FOUNDATION.
 * @param clientIp IP được dùng làm tín hiệu phụ cho Google, không ghi log raw.
 */
export async function verifyRecaptchaToken(
  token: string,
  expectedAction: string,
  clientIp: string
): Promise<RecaptchaVerdict> {
  if (!isRecaptchaVerificationEnabled() && process.env.NODE_ENV !== 'production') {
    logger.warn('reCAPTCHA verification is disabled outside production.');
    return { isVerified: true, score: 1 };
  }

  let secretKey: string;
  let minimumScore: number;
  try {
    secretKey = getRecaptchaSecretKey();
    minimumScore = getRecaptchaMinimumScore();
  } catch {
    return { isVerified: false, reason: 'DISABLED_MISCONFIG' };
  }
  if (!secretKey) return { isVerified: false, reason: 'DISABLED_MISCONFIG' };

  const requestBody = new URLSearchParams({ secret: secretKey, response: token });
  if (clientIp) requestBody.set('remoteip', clientIp);

  try {
    const response = await fetch(RECAPTCHA_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody,
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { isVerified: false, reason: 'REJECTED' };

    const responseBody = await response.json() as RecaptchaApiResponse;
    if (responseBody.success !== true) return { isVerified: false, reason: 'REJECTED' };
    if (responseBody.action !== expectedAction) return { isVerified: false, reason: 'ACTION_MISMATCH' };

    const score = typeof responseBody.score === 'number' ? responseBody.score : 0;
    if (score < minimumScore) return { isVerified: false, reason: 'LOW_SCORE' };
    return { isVerified: true, score };
  } catch {
    logger.warn('reCAPTCHA verification network request failed.');
    return { isVerified: false, reason: 'NETWORK' };
  }
}
