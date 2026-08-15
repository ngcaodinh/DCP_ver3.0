import crypto from 'crypto';
import net from 'node:net';
import type { Request } from 'express';
import { getPublicFeedbackClientIpHmacKey } from '../config/publicFeedbackRuntimeConfig';
import { getLogger } from '../config/logger';

export const PUBLIC_FEEDBACK_CLIENT_IP_HEADER = 'X-Feedback-Client-IP';
export const PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER = 'X-Feedback-Client-IP-Signature';
export const PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS = 5 * 60 * 1000;
const IDENTITY_WARNING_INTERVAL_MILLISECONDS = 60_000;
const logger = getLogger();
let lastIdentityWarningAtMilliseconds: number | null = null;

export interface PublicFeedbackClientIpVerification {
  clientIp: string;
  isVerified: boolean;
}

/** Tạo chữ ký identity theo bucket thời gian để chữ ký bị rò rỉ tự hết hạn. */
export function createPublicFeedbackClientIpSignature(
  clientIp: string,
  timestampMilliseconds = Date.now()
): string {
  const timeBucket = Math.floor(
    timestampMilliseconds / PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS
  );
  return crypto
    .createHmac('sha256', getPublicFeedbackClientIpHmacKey())
    .update(`${clientIp}|${timeBucket}`, 'utf8')
    .digest('hex');
}

/** So sánh chữ ký sau khi kiểm tra độ dài để timingSafeEqual không ném lỗi. */
function matchesSignature(providedSignature: string, expectedSignature: string): boolean {
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Cảnh báo có giới hạn khi client gửi identity không hợp lệ để phân biệt lỗi cấu hình với request không có header. */
function warnInvalidIdentityHeaders(): void {
  const now = Date.now();
  if (
    lastIdentityWarningAtMilliseconds !== null &&
    now - lastIdentityWarningAtMilliseconds < IDENTITY_WARNING_INTERVAL_MILLISECONDS
  ) {
    return;
  }
  lastIdentityWarningAtMilliseconds = now;
  logger.warn('Public feedback client identity verification failed; falling back to request IP.');
}

/** Xác minh identity SSR do frontend ký và trả trạng thái để healthcheck không nhầm IP fallback là identity đáng tin. */
export function verifyPublicFeedbackClientIp(request: Request): PublicFeedbackClientIpVerification {
  const claimedIp = request.get(PUBLIC_FEEDBACK_CLIENT_IP_HEADER)?.trim() || '';
  const providedSignature = request.get(PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER)?.trim() || '';
  const fallbackClientIp = request.ip || 'unknown';
  const hasIdentityHeaders = Boolean(claimedIp || providedSignature);
  if (net.isIP(claimedIp) === 0 || !providedSignature) {
    if (hasIdentityHeaders) warnInvalidIdentityHeaders();
    return { clientIp: fallbackClientIp, isVerified: false };
  }

  const currentTimestamp = Date.now();
  const isVerified = [
    currentTimestamp,
    currentTimestamp - PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS,
    currentTimestamp + PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS
  ].some(timestamp => matchesSignature(
    providedSignature,
    createPublicFeedbackClientIpSignature(claimedIp, timestamp)
  ));
  if (!isVerified) {
    warnInvalidIdentityHeaders();
    return { clientIp: fallbackClientIp, isVerified: false };
  }

  return { clientIp: claimedIp, isVerified: true };
}

/** Lấy IP dự phòng cho rate limit và quota, chỉ dùng claimed IP khi verifier HMAC xác nhận hợp lệ. */
export function getPublicFeedbackClientIp(request: Request): string {
  return verifyPublicFeedbackClientIp(request).clientIp;
}

/** Xóa trạng thái cảnh báo identity giữa các kiểm thử đơn vị mà không ảnh hưởng runtime. */
export function __resetPublicFeedbackClientIdentityWarningStateForTests(): void {
  lastIdentityWarningAtMilliseconds = null;
}
