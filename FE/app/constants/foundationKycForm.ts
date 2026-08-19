/** Hằng số và thông báo whitelist cho form KYC FOUNDATION public. */
export const FOUNDATION_KYC_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Danh sách ngân hàng doanh nghiệp được payOS công bố hỗ trợ liên kết; nguồn: https://payos.vn/3-phut-hieu-ro-ve-payos/. */
export const FOUNDATION_KYC_SUPPORTED_BANKS = [
  { value: 'MB', label: 'MB' },
  { value: 'KienlongBank', label: 'KienlongBank' },
  { value: 'OCB', label: 'OCB' },
  { value: 'BIDV', label: 'BIDV' },
  { value: 'Shinhan Bank', label: 'Shinhan Bank' },
  { value: 'ACB', label: 'ACB' }
] as const;

/** MIME type được phép ở client, đồng bộ với validator backend. */
export const FOUNDATION_KYC_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg'
] as const;

/** Ánh xạ errorCode backend sang thông báo dễ hiểu, không làm lộ lỗi nội bộ. */
export const FOUNDATION_KYC_ERROR_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Vui lòng kiểm tra lại thông tin trong hồ sơ.',
  CAPTCHA_FAILED: 'Không thể xác minh reCAPTCHA. Vui lòng thử lại sau ít phút.',
  DUPLICATE_SUBMISSION: 'Hồ sơ của Quỹ đang chờ Cơ quan giám sát duyệt. Vui lòng không gửi lại lúc này.',
  CONFLICT: 'Hồ sơ đã được xử lý hoặc tài khoản ngân hàng đã được sử dụng. Vui lòng liên hệ Cơ quan giám sát.',
  DUPLICATE_LEGAL_REGISTRATION_NUMBER: 'Số đăng ký pháp nhân đã thuộc một tổ chức khác.',
  FILE_TOO_LARGE: 'File vượt quá giới hạn 5MB. Vui lòng chọn file nhỏ hơn.',
  UNSUPPORTED_MEDIA_TYPE: 'File không đúng định dạng hoặc nội dung không khớp.',
  RATE_LIMIT_EXCEEDED: 'Bạn đã thao tác quá nhiều. Vui lòng thử lại sau ít phút.'
};

/** Lấy thông báo lỗi an toàn cho mã lỗi API, không hiển thị raw message từ server. */
export function getFoundationKycErrorMessage(errorCode: string | undefined): string {
  return (errorCode && FOUNDATION_KYC_ERROR_MESSAGES[errorCode])
    || 'Không thể gửi hồ sơ. Vui lòng thử lại sau.';
}
