import fs from 'fs';

const MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH = 32;
const DEVELOPMENT_CLIENT_IP_HMAC_KEY = 'dcp-feedback-client-ip-development-key-rotate-me';
let feedbackClientIpHmacKey: string | undefined;

/** Đọc shared HMAC từ secret file read-only; chỉ dùng env trực tiếp cho local/test tương thích. */
function readConfiguredClientIpHmacKey(): string {
  const keyFilePath = process.env.FEEDBACK_CLIENT_IP_HMAC_KEY_FILE?.trim() || '';
  if (keyFilePath) {
    try {
      return fs.readFileSync(keyFilePath, 'utf8').trim();
    } catch {
      throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE cannot be read.');
    }
  }
  return process.env.FEEDBACK_CLIENT_IP_HMAC_KEY?.trim() || '';
}

/** Lấy shared HMAC key dùng chung với backend, fail-fast khi production thiếu hoặc dùng sentinel. */
export function getFeedbackClientIpHmacKey(): string {
  if (feedbackClientIpHmacKey !== undefined) return feedbackClientIpHmacKey;

  const configuredKey = readConfiguredClientIpHmacKey();
  if (process.env.NODE_ENV === 'production') {
    if (!configuredKey) throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY is not configured in production.');
    if (configuredKey.length < MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH) {
      throw new Error(
        `FEEDBACK_CLIENT_IP_HMAC_KEY must be at least ${MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH} characters in production.`
      );
    }
    if (/^(?:CHANGE_ME_|YOUR_|REPLACE_ME|CHANGEME)/iu.test(configuredKey)) {
      throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY must not use a production placeholder value.');
    }
    if (configuredKey === DEVELOPMENT_CLIENT_IP_HMAC_KEY) {
      throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY must not use the development key.');
    }
  }
  feedbackClientIpHmacKey = configuredKey || DEVELOPMENT_CLIENT_IP_HMAC_KEY;
  return feedbackClientIpHmacKey;
}

/** Xóa cache HMAC nội bộ để cô lập cấu hình giữa các test; không sử dụng trong runtime. */
export function __resetFeedbackClientIpHmacKeyCacheForTests(): void {
  feedbackClientIpHmacKey = undefined;
}

/** Kiểm tra shared HMAC ngay khi Next.js Node runtime khởi động thay vì đợi route feedback đầu tiên. */
export function validateFeedbackClientIdentityConfig(): void {
  if (process.env.NODE_ENV === 'production') getFeedbackClientIpHmacKey();
}
