import fs from 'node:fs';

const MINIMUM_RECAPTCHA_SECRET_LENGTH = 16;
const MINIMUM_IP_HASH_SALT_LENGTH = 32;
const DEFAULT_RECAPTCHA_MIN_SCORE = 0.5;
const DEVELOPMENT_IP_HASH_SALT = 'dcp-foundation-kyc-ip-development-salt-rotate-me';
let cachedRecaptchaSecretKey: string | undefined;
let cachedIpHashSalt: string | undefined;

/** Nhận diện giá trị mẫu không được phép chạy trong production. */
function isProductionPlaceholder(value: string): boolean {
  return /^(?:CHANGE_ME_|YOUR_|REPLACE_ME|CHANGEME)/iu.test(value);
}

/** Đọc secret reCAPTCHA từ file read-only khi deployment không truyền secret trực tiếp qua env. */
function readRecaptchaSecretKey(): string {
  const secretFilePath = process.env.RECAPTCHA_SECRET_KEY_FILE?.trim() || '';
  if (secretFilePath) {
    try {
      return fs.readFileSync(secretFilePath, 'utf8').trim();
    } catch {
      throw new Error('RECAPTCHA_SECRET_KEY_FILE cannot be read.');
    }
  }
  return process.env.RECAPTCHA_SECRET_KEY?.trim() || '';
}

/** Lấy secret reCAPTCHA và fail-fast khi production thiếu secret hoặc dùng placeholder. */
export function getRecaptchaSecretKey(): string {
  if (cachedRecaptchaSecretKey !== undefined) return cachedRecaptchaSecretKey;

  const configuredSecretKey = readRecaptchaSecretKey();
  if (!configuredSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RECAPTCHA_SECRET_KEY is not configured in production.');
    }
    return '';
  }

  if (process.env.NODE_ENV === 'production' && configuredSecretKey.length < MINIMUM_RECAPTCHA_SECRET_LENGTH) {
    throw new Error(`RECAPTCHA_SECRET_KEY must be at least ${MINIMUM_RECAPTCHA_SECRET_LENGTH} characters in production.`);
  }
  if (process.env.NODE_ENV === 'production' && isProductionPlaceholder(configuredSecretKey)) {
    throw new Error('RECAPTCHA_SECRET_KEY must not use a production placeholder value.');
  }

  cachedRecaptchaSecretKey = configuredSecretKey;
  return cachedRecaptchaSecretKey;
}

/** Lấy ngưỡng điểm reCAPTCHA v3 và chặn cấu hình nằm ngoài khoảng hợp lệ. */
export function getRecaptchaMinimumScore(): number {
  const configuredScore = process.env.RECAPTCHA_MIN_SCORE?.trim() || '';
  if (!configuredScore) return DEFAULT_RECAPTCHA_MIN_SCORE;

  const parsedScore = Number(configuredScore);
  if (!Number.isFinite(parsedScore) || parsedScore < 0 || parsedScore > 1) {
    throw new Error('RECAPTCHA_MIN_SCORE must be a number between 0 and 1.');
  }
  return parsedScore;
}

/** Xác định captcha có được bật chủ động trong môi trường hiện tại hay không. */
export function isRecaptchaVerificationEnabled(): boolean {
  return process.env.RECAPTCHA_ENABLED?.trim().toLowerCase() === 'true';
}

/** Lấy salt HMAC dùng để băm IP trước khi ghi quota, không lưu IP thô vào Redis. */
export function getFoundationKycIpHashSalt(): string {
  if (cachedIpHashSalt !== undefined) return cachedIpHashSalt;

  const configuredSalt = process.env.FOUNDATION_KYC_IP_HASH_SALT?.trim()
    || process.env.FEEDBACK_IP_HASH_SALT?.trim()
    || '';
  if (!configuredSalt) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FOUNDATION_KYC_IP_HASH_SALT is not configured in production.');
    }
    cachedIpHashSalt = DEVELOPMENT_IP_HASH_SALT;
    return cachedIpHashSalt;
  }

  if (process.env.NODE_ENV === 'production' && configuredSalt.length < MINIMUM_IP_HASH_SALT_LENGTH) {
    throw new Error(`FOUNDATION_KYC_IP_HASH_SALT must be at least ${MINIMUM_IP_HASH_SALT_LENGTH} characters in production.`);
  }
  if (process.env.NODE_ENV === 'production' && isProductionPlaceholder(configuredSalt)) {
    throw new Error('FOUNDATION_KYC_IP_HASH_SALT must not use a production placeholder value.');
  }

  cachedIpHashSalt = configuredSalt;
  return cachedIpHashSalt;
}

/** Kiểm tra toàn bộ cấu hình bắt buộc lúc backend boot trong production. */
export function validateFoundationKycRuntimeConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;

  getRecaptchaSecretKey();
  getRecaptchaMinimumScore();
  getFoundationKycIpHashSalt();
}

/** Xóa cache cấu hình giữa các test để mỗi case cô lập env của mình. */
export function __resetFoundationKycRuntimeConfigForTests(): void {
  cachedRecaptchaSecretKey = undefined;
  cachedIpHashSalt = undefined;
}

