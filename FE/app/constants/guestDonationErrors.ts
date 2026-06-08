/**
 * Các thông điệp lỗi được map từ GuestApiErrorCode sang tiếng Việt.
 * Tách riêng để dễ maintain, mở rộng i18n, và tránh phình file Provider.
 */
import type { GuestApiErrorCode } from '../utils/guestApiClient';

/** Mapping error code → thông điệp tiếng Việt cho user */
export const GUEST_DONATION_ERROR_MESSAGES: Partial<Record<GuestApiErrorCode, string>> = {
  GUEST_DONATION_QUOTA_EXCEEDED: 'Bạn đã đạt giới hạn 3 lần quyên góp cho phiên này.',
  GUEST_AMOUNT_LIMIT_EXCEEDED:
    'Tổng số token quyên góp đã vượt quá giới hạn cho phép (tối đa 600,000 token/phiên).',
  GUEST_DONATION_RATE_LIMIT_EXCEEDED: 'Tần suất quá cao. Vui lòng chờ một chút rồi thử lại.',
  GUEST_SESSION_NOT_ACTIVE: 'Phiên guest đã hết hạn. Vui lòng khởi tạo ví mới.',
  GUEST_TOKEN_INVALID: 'Token phiên không hợp lệ. Vui lòng khởi tạo ví mới.',
  GUEST_TOKEN_REQUIRED: 'Token phiên không tồn tại. Vui lòng khởi tạo ví mới.',
  PAYMASTER_POLICY_MISMATCH: 'Hệ thống tài trợ gas chưa sẵn sàng. Vui lòng thử lại sau.',
  DUPLICATE_USEROP: 'Giao dịch đã được gửi trước đó. Vui lòng đợi kết quả.',
  GUEST_SESSION_NOT_FOUND: 'Không tìm thấy phiên guest. Vui lòng khởi tạo ví mới.',
  INVALID_CALLDATA: 'Dữ liệu giao dịch không hợp lệ. Vui lòng thử lại.',
  FORBIDDEN: 'Hành động không được phép.',
  CONFLICT: 'Xung đột dữ liệu. Vui lòng thử lại.',
  INTERNAL_ERROR: 'Lỗi server. Vui lòng thử lại sau.',
  UNKNOWN_ERROR: 'Không thể thực hiện quyên góp lúc này. Vui lòng thử lại sau.',
};
