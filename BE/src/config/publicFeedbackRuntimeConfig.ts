import fs from 'node:fs';

const MINIMUM_IP_HASH_SALT_LENGTH = 32;
const MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH = 32;
const DEVELOPMENT_FRONTEND_URL = 'http://localhost:3000';
const DEVELOPMENT_CLIENT_IP_HMAC_KEY = 'dcp-feedback-client-ip-development-key-rotate-me';
let publicFeedbackClientIpHmacKey: string | undefined;

/** Nhận diện giá trị mẫu không được phép chạy trong production dù đã đủ độ dài. */
function isProductionPlaceholder(value: string): boolean {
  return /^(?:CHANGE_ME_|YOUR_|REPLACE_ME|CHANGEME)/iu.test(value);
}

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

/** Lấy salt bí mật dùng để băm IP; production không được chạy với salt thiếu/yếu. */
export function getPublicFeedbackIpHashSalt(): string {
  const configuredSalt = process.env.FEEDBACK_IP_HASH_SALT?.trim() || '';
  if (configuredSalt) {
    if (process.env.NODE_ENV === 'production' && configuredSalt.length < MINIMUM_IP_HASH_SALT_LENGTH) {
      throw new Error(
        `FEEDBACK_IP_HASH_SALT must be at least ${MINIMUM_IP_HASH_SALT_LENGTH} characters in production.`
      );
    }
    if (process.env.NODE_ENV === 'production' && isProductionPlaceholder(configuredSalt)) {
      throw new Error('FEEDBACK_IP_HASH_SALT must not use a production placeholder value.');
    }
    return configuredSalt;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('FEEDBACK_IP_HASH_SALT is not configured in production.');
  }

  return 'dcp-feedback-ip-development-salt-rotate-me';
}

/** Lấy secret ký identity SSR giữa Nginx, Next.js và backend; không bao giờ tin header chưa được ký. */
export function getPublicFeedbackClientIpHmacKey(): string {
  if (publicFeedbackClientIpHmacKey !== undefined) return publicFeedbackClientIpHmacKey;

  const configuredKey = readConfiguredClientIpHmacKey();
  if (configuredKey) {
    if (process.env.NODE_ENV === 'production' && configuredKey.length < MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH) {
      throw new Error(
        `FEEDBACK_CLIENT_IP_HMAC_KEY must be at least ${MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH} characters in production.`
      );
    }
    if (process.env.NODE_ENV === 'production' && isProductionPlaceholder(configuredKey)) {
      throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY must not use a production placeholder value.');
    }
    if (process.env.NODE_ENV === 'production' && configuredKey === DEVELOPMENT_CLIENT_IP_HMAC_KEY) {
      throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY must not use the development key.');
    }
    publicFeedbackClientIpHmacKey = configuredKey;
    return publicFeedbackClientIpHmacKey;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('FEEDBACK_CLIENT_IP_HMAC_KEY is not configured in production.');
  }

  publicFeedbackClientIpHmacKey = DEVELOPMENT_CLIENT_IP_HMAC_KEY;
  return publicFeedbackClientIpHmacKey;
}

/** Xóa cache HMAC nội bộ để cô lập cấu hình giữa các test; không sử dụng trong runtime. */
export function __resetPublicFeedbackClientIpHmacKeyCacheForTests(): void {
  publicFeedbackClientIpHmacKey = undefined;
}

/** Lấy origin frontend dùng cho redirect no-JS, không fallback về localhost ở production. */
export function getPublicFeedbackFrontendUrl(): string {
  const configuredUrl = process.env.FRONTEND_URL?.trim() || '';
  if (!configuredUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FRONTEND_URL is not configured in production.');
    }
    return DEVELOPMENT_FRONTEND_URL;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error('FRONTEND_URL must be an absolute HTTP(S) URL.');
  }

  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    !/^\/+$/u.test(parsedUrl.pathname) ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error('FRONTEND_URL must be an absolute HTTP(S) URL origin without credentials or path/query data.');
  }

  return configuredUrl.replace(/\/+$/u, '');
}

/** Fail-fast toàn bộ cấu hình runtime bắt buộc của public feedback trong production. */
export function validatePublicFeedbackRuntimeConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;

  getPublicFeedbackIpHashSalt();
  getPublicFeedbackClientIpHmacKey();
  getPublicFeedbackFrontendUrl();
}

export {
  DEVELOPMENT_CLIENT_IP_HMAC_KEY,
  MINIMUM_CLIENT_IP_HMAC_KEY_LENGTH,
  MINIMUM_IP_HASH_SALT_LENGTH,
  isProductionPlaceholder
};
