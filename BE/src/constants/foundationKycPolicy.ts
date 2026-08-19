/** Chính sách chống flood và giới hạn file cho cổng KYC FOUNDATION công khai. */
export const FOUNDATION_KYC_SUBMISSION_POLICY = {
  minute: {
    maxRequests: 3,
    ttlSeconds: 60,
    windowMs: 60 * 1000
  },
  daily: {
    maxRequests: 5,
    ttlSeconds: 24 * 60 * 60
  }
} as const;

/** Kích thước file tối đa sau khi giải mã base64. */
export const FOUNDATION_KYC_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Danh sách ngân hàng doanh nghiệp được payOS công bố hỗ trợ liên kết; nguồn: https://payos.vn/3-phut-hieu-ro-ve-payos/. */
export const FOUNDATION_KYC_SUPPORTED_BANK_NAMES = [
  'MB',
  'KienlongBank',
  'OCB',
  'BIDV',
  'Shinhan Bank',
  'ACB'
] as const;

/** MIME type được phép cho giấy tờ pháp lý FOUNDATION. */
export const FOUNDATION_KYC_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg'
] as const;
