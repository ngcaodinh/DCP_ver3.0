import crypto from 'node:crypto';
import net from 'node:net';
import { headers } from 'next/headers';
import { getFeedbackClientIpHmacKey } from '../../utils/feedbackClientIdentityConfig';

const CLIENT_IP_HEADER = 'X-Feedback-Client-IP';
const CLIENT_IP_SIGNATURE_HEADER = 'X-Feedback-Client-IP-Signature';
export const CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS = 5 * 60 * 1000;
const IDENTITY_WARNING_INTERVAL_MILLISECONDS = 60_000;
let lastInvalidIdentityWarningAtMilliseconds: number | null = null;

/** Cảnh báo có giới hạn khi edge không chuyển được IP hợp lệ cho SSR feedback. */
function warnMissingOrInvalidClientIdentity(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const now = Date.now();
  if (
    lastInvalidIdentityWarningAtMilliseconds !== null &&
    now - lastInvalidIdentityWarningAtMilliseconds < IDENTITY_WARNING_INTERVAL_MILLISECONDS
  ) {
    return;
  }
  lastInvalidIdentityWarningAtMilliseconds = now;
  console.warn(
    'Public feedback client identity header is missing or invalid; SSR requests may share the frontend container IP.'
  );
}

/** Đọc IP do reverse proxy ghi đè vào request frontend; không đọc X-Forwarded-For từ trình duyệt. */
export function getTrustedFeedbackClientIp(): string | null {
  getFeedbackClientIpHmacKey();
  const candidateIp = headers().get(CLIENT_IP_HEADER)?.trim() || '';
  if (net.isIP(candidateIp) === 0) {
    warnMissingOrInvalidClientIdentity();
    return null;
  }
  return candidateIp;
}

/** Ký IP edge theo bucket thời gian trước khi Next.js gọi API form-context và stats. */
export function createFeedbackClientIdentityHeaders(clientIp: string | null): Record<string, string> {
  if (!clientIp) return {};
  const timeBucket = Math.floor(Date.now() / CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS);
  const signature = crypto
    .createHmac('sha256', getFeedbackClientIpHmacKey())
    .update(`${clientIp}|${timeBucket}`, 'utf8')
    .digest('hex');
  return {
    [CLIENT_IP_HEADER]: clientIp,
    [CLIENT_IP_SIGNATURE_HEADER]: signature
  };
}

/** Xóa trạng thái cảnh báo identity giữa các kiểm thử mà không ảnh hưởng runtime. */
export function __resetFeedbackClientIdentityWarningStateForTests(): void {
  lastInvalidIdentityWarningAtMilliseconds = null;
}
