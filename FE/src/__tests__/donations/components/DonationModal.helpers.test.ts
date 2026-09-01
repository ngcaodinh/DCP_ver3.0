/**
 * Unit tests cho DonationModal.helpers — các hàm utility dùng chung trong DonationModal.
 * Pattern giống các test files hiện có trong project.
 */
import { describe, it, expect } from 'vitest';
import {
  formatWalletAddress,
  formatTransactionHash,
  isCampaignBeforeDeadline,
  mapTransactionStatusToVietnamese,
  mapGuestTransactionStatusToVietnamese,
  resolveGuestDisplayStatusRaw,
  mapDonationErrorMessage,
} from '@/app/donations/components/DonationModal.helpers';
import { GuestApiError } from '@/app/utils/guestApiClient';

describe('DonationModal.helpers', () => {
  describe('formatWalletAddress', () => {
    it('should truncate address longer than 10 characters', () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD';
      const result = formatWalletAddress(address);
      expect(result).toBe('0x742d...E8eD');
    });

    it('should return full address when 10 characters or less', () => {
      const shortAddress = '0x742d35Cc';
      const result = formatWalletAddress(shortAddress);
      expect(result).toBe('0x742d35Cc');
    });

    it('should return truncated address for 11-char (10 non-prefix) input', () => {
      // '0x742d35Cc6' = 11 chars → condition IS met → truncate: '0x742d' + '...' + '5Cc6'
      const exactAddress = '0x742d35Cc6';
      const result = formatWalletAddress(exactAddress);
      expect(result).toBe('0x742d...5Cc6');
    });

    it('should return empty string for empty input', () => {
      const result = formatWalletAddress('');
      expect(result).toBe('');
    });

    it('should handle address with mixed case correctly', () => {
      const mixedCase = '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD';
      const result = formatWalletAddress(mixedCase);
      expect(result).toBe('0x742d...E8eD');
    });
  });

  describe('formatTransactionHash', () => {
    it('should truncate tx hash longer than 20 characters', () => {
      const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      // slice(0, 10) = '0xabcdef12', slice(-8) = '34567890'
      const result = formatTransactionHash(txHash);
      expect(result).toBe('0xabcdef12...34567890');
    });

    it('should return full hash when 20 characters or less', () => {
      const shortHash = '0xabcdef1234567890ab';
      const result = formatTransactionHash(shortHash);
      expect(result).toBe('0xabcdef1234567890ab');
    });

    it('should return exact hash at 20 characters', () => {
      const exactHash = '0xabcdef123456789012';
      const result = formatTransactionHash(exactHash);
      expect(result).toBe('0xabcdef123456789012');
    });

    it('should return empty string for empty input', () => {
      const result = formatTransactionHash('');
      expect(result).toBe('');
    });

    it('should handle short hash of exactly 20 chars with ellipsis', () => {
      const twentyChars = '0x123456789012345678';
      const result = formatTransactionHash(twentyChars);
      expect(result).toBe('0x123456789012345678');
    });
  });

  describe('isCampaignBeforeDeadline', () => {
    it('should return true when deadline is in the future', () => {
      const futureDeadline = new Date(Date.now() + 86400000).toISOString();
      const result = isCampaignBeforeDeadline(futureDeadline);
      expect(result).toBe(true);
    });

    it('should return false when deadline is in the past', () => {
      const pastDeadline = new Date(Date.now() - 86400000).toISOString();
      const result = isCampaignBeforeDeadline(pastDeadline);
      expect(result).toBe(false);
    });

    it('should return true when deadline is undefined', () => {
      const result = isCampaignBeforeDeadline(undefined);
      expect(result).toBe(true);
    });

    it('should return true when deadline is null', () => {
      const result = isCampaignBeforeDeadline(null as unknown as string);
      expect(result).toBe(true);
    });

    it('should return true when deadline is empty string', () => {
      const result = isCampaignBeforeDeadline('');
      expect(result).toBe(true);
    });

    it('should return true when deadline is invalid date string', () => {
      const result = isCampaignBeforeDeadline('not-a-date');
      expect(result).toBe(true);
    });

    it('should return true when deadline equals now (boundary)', () => {
      const nowDeadline = new Date(Date.now()).toISOString();
      const result = isCampaignBeforeDeadline(nowDeadline);
      expect(result).toBe(true);
    });
  });

  describe('mapTransactionStatusToVietnamese', () => {
    it('should map idle status', () => {
      const result = mapTransactionStatusToVietnamese('idle');
      expect(result).toBe('Sẵn sàng');
    });

    it('should map processing status', () => {
      const result = mapTransactionStatusToVietnamese('processing');
      expect(result).toBe('Đang xử lý');
    });

    it('should map submitted status', () => {
      const result = mapTransactionStatusToVietnamese('submitted');
      expect(result).toBe('Đã gửi giao dịch');
    });

    it('should map finalizing status', () => {
      const result = mapTransactionStatusToVietnamese('finalizing');
      expect(result).toBe('Đang chờ blockchain finality');
    });

    it('should map success status', () => {
      const result = mapTransactionStatusToVietnamese('success');
      expect(result).toBe('Thành công');
    });

    it('should map failed status', () => {
      const result = mapTransactionStatusToVietnamese('failed');
      expect(result).toBe('Thất bại');
    });
  });

  describe('mapGuestTransactionStatusToVietnamese', () => {
    it('should map idle status', () => {
      const result = mapGuestTransactionStatusToVietnamese('idle');
      expect(result).toBe('Sẵn sàng');
    });

    it('should map decrypting status', () => {
      const result = mapGuestTransactionStatusToVietnamese('decrypting');
      expect(result).toBe('Đang giải mã khóa ví...');
    });

    it('should map building status', () => {
      const result = mapGuestTransactionStatusToVietnamese('building');
      expect(result).toBe('Đang xây dựng giao dịch...');
    });

    it('should map paymaster status', () => {
      const result = mapGuestTransactionStatusToVietnamese('paymaster');
      expect(result).toBe('Đang yêu cầu tài trợ gas...');
    });

    it('should map submitting status', () => {
      const result = mapGuestTransactionStatusToVietnamese('submitting');
      expect(result).toBe('Đang gửi lên blockchain...');
    });

    it('should map indexing status', () => {
      const result = mapGuestTransactionStatusToVietnamese('indexing');
      expect(result).toBe('Đang ghi nhận vào hệ thống...');
    });

    it('should map success status', () => {
      const result = mapGuestTransactionStatusToVietnamese('success');
      expect(result).toBe('Thành công');
    });

    it('should map failed status', () => {
      const result = mapGuestTransactionStatusToVietnamese('failed');
      expect(result).toBe('Thất bại');
    });
  });

  describe('resolveGuestDisplayStatusRaw', () => {
    it('should map IDLE to idle', () => {
      const result = resolveGuestDisplayStatusRaw('IDLE');
      expect(result).toBe('idle');
    });

    it('should map DECRYPTING_KEY to decrypting', () => {
      const result = resolveGuestDisplayStatusRaw('DECRYPTING_KEY');
      expect(result).toBe('decrypting');
    });

    it('should map BUILDING_USER_OP to building', () => {
      const result = resolveGuestDisplayStatusRaw('BUILDING_USER_OP');
      expect(result).toBe('building');
    });

    it('should map REQUESTING_PAYMASTER to paymaster', () => {
      const result = resolveGuestDisplayStatusRaw('REQUESTING_PAYMASTER');
      expect(result).toBe('paymaster');
    });

    it('should map SUBMITTING_BUNDLER to submitting', () => {
      const result = resolveGuestDisplayStatusRaw('SUBMITTING_BUNDLER');
      expect(result).toBe('submitting');
    });

    it('should map INDEXING to indexing', () => {
      const result = resolveGuestDisplayStatusRaw('INDEXING');
      expect(result).toBe('indexing');
    });

    it('should map SUCCESS to success', () => {
      const result = resolveGuestDisplayStatusRaw('SUCCESS');
      expect(result).toBe('success');
    });

    it('should map FAILED to failed', () => {
      const result = resolveGuestDisplayStatusRaw('FAILED');
      expect(result).toBe('failed');
    });

    it('should return idle for unknown status', () => {
      const result = resolveGuestDisplayStatusRaw('UNKNOWN_STATUS');
      expect(result).toBe('idle');
    });

    it('should return idle for empty string', () => {
      const result = resolveGuestDisplayStatusRaw('');
      expect(result).toBe('idle');
    });
  });

  describe('mapDonationErrorMessage', () => {
    it('should map 401 unauthorized error', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Unauthorized',
        errorCode: 'FORBIDDEN',
        statusCode: 401,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Bạn chưa đăng nhập hoặc phiên đã hết hạn. Vui lòng đăng nhập lại để ghi nhận quyên góp.');
    });

    it('should map CHAIN_MISMATCH error', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Chain mismatch',
        errorCode: 'CHAIN_MISMATCH',
        statusCode: 400,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Hệ thống backend đang ở sai mạng blockchain. Vui lòng thử lại sau.');
    });

    it('should map TRANSACTION_TIMEOUT error', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Timeout',
        errorCode: 'TRANSACTION_TIMEOUT',
        statusCode: 408,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Giao dịch đang pending quá lâu. Vui lòng đợi thêm hoặc thử lại sau.');
    });

    it('should map TRANSACTION_REVERTED error', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Reverted',
        errorCode: 'TRANSACTION_REVERTED',
        statusCode: 400,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Giao dịch bị từ chối trên blockchain. Vui lòng kiểm tra lại số dư token.');
    });

    it('should map PAYMASTER_POLICY_MISMATCH error', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Policy mismatch',
        errorCode: 'PAYMASTER_POLICY_MISMATCH',
        statusCode: 400,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Hệ thống tài trợ phí gas chưa cấu hình policy phù hợp cho giao dịch quyên góp. Vui lòng liên hệ quản trị viên.');
    });

    it('should map VALIDATION_ERROR with custom message', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Invalid project ID',
        errorCode: 'VALIDATION_ERROR',
        statusCode: 400,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Invalid project ID');
    });

    it('should map VALIDATION_ERROR with fallback message when message is empty', () => {
      const error = new GuestApiError({
        success: false,
        message: '',
        errorCode: 'VALIDATION_ERROR',
        statusCode: 400,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Dữ liệu ghi nhận quyên góp không hợp lệ. Vui lòng kiểm tra lại thông tin.');
    });

    it('should map native Error with message property', () => {
      const error = new Error('Network error');
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Network error');
    });

    it('should return fallback message for unknown error without properties', () => {
      const error = 'unknown error string';
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Không thể xử lý quyên góp lúc này. Vui lòng thử lại sau.');
    });

    it('should map error with errorCode but no message', () => {
      const error = new GuestApiError({
        success: false,
        message: '',
        errorCode: 'SOME_ERROR',
        statusCode: 500,
      });
      const result = mapDonationErrorMessage(error);
      expect(result).toBe('Không thể xử lý quyên góp lúc này. Vui lòng thử lại sau.');
    });
  });
});
