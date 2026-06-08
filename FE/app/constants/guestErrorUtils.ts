/**
 * Các hàm xử lý lỗi cho Guest Donation flow.
 * Tách riêng để tránh DRY violation khi dùng chung giữa các hooks.
 */
import { GUEST_DONATION_ERROR_MESSAGES } from './guestDonationErrors';
import { GuestApiError } from '../utils/guestApiClient';

/**
 * Lấy thông điệp lỗi từ error object.
 * Mục đích: map GuestApiError + native Error + unknown thành message tiếng Việt.
 * Dùng chung cho cả useGuestSessionManager và useGuestWalletOps.
 */
export function getDonationErrorMessage(error: unknown): string {
  if (error instanceof GuestApiError) {
    const mapped = GUEST_DONATION_ERROR_MESSAGES[error.errorCode];
    if (mapped) return mapped;
    return error.message || GUEST_DONATION_ERROR_MESSAGES.UNKNOWN_ERROR!;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return GUEST_DONATION_ERROR_MESSAGES.UNKNOWN_ERROR!;
}
