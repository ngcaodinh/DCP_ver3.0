/**
 * Các hàm helper dùng chung trong DonationModal.
 * Tách riêng để giảm size DonationModal.tsx và tái sử dụng trong test files.
 */
import type { ApiErrorResponse } from '../../utils/apiClient';
import type { TransactionStatus, GuestTransactionStatus } from './DonationModal.types';

/** Hàm rút gọn địa chỉ ví. Mục đích: hiển thị donor address ngắn gọn trong lịch sử donation. */
export function formatWalletAddress(walletAddress: string): string {
  return walletAddress.length > 10 ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : walletAddress;
}

/** Hàm rút gọn transaction hash. Mục đích: hiển thị TxHash ngắn gọn, dễ đọc cho người dùng. */
export function formatTransactionHash(transactionHash: string): string {
  return transactionHash.length > 20 ? `${transactionHash.slice(0, 10)}...${transactionHash.slice(-8)}` : transactionHash;
}

/** Hàm kiểm tra campaign còn hạn donate. Mục đích: chặn donate khi campaign đã quá hạn. */
export function isCampaignBeforeDeadline(deadlineIso?: string): boolean {
  if (!deadlineIso) return true;
  const parsedDeadline = new Date(deadlineIso);
  if (Number.isNaN(parsedDeadline.getTime())) return true;
  return parsedDeadline.getTime() >= Date.now();
}

/**
 * Hàm chuẩn hóa projectId cho relay. Mục đích: hỗ trợ cả mã thuần số và mã có chứa số như PRJ-1001.
 * Dùng bởi authenticated donation flow trong DonationModal.services.ts.
 */
export function resolveRelayProjectId(projectId: string): string {
  const normalizedProjectId = projectId.trim();
  if (/^[0-9]+$/.test(normalizedProjectId)) return normalizedProjectId;
  const numericPartMatch = normalizedProjectId.match(/([0-9]+)/);
  if (numericPartMatch?.[1]) return numericPartMatch[1];
  return '';
}

/**
 * Hàm chuyển trạng thái giao dịch sang tiếng Việt.
 * Mục đích: hiển thị trạng thái rõ ràng cho người dùng authenticated.
 */
export function mapTransactionStatusToVietnamese(statusValue: TransactionStatus): string {
  switch (statusValue) {
    case 'idle': return 'Sẵn sàng';
    case 'processing': return 'Đang xử lý';
    case 'submitted': return 'Đã gửi giao dịch';
    case 'finalizing': return 'Đang chờ blockchain finality';
    case 'success': return 'Thành công';
    case 'failed': return 'Thất bại';
  }
}

/**
 * Hàm chuyển trạng thái guest donation sang tiếng Việt.
 * Mục đích: hiển thị trạng thái EIP-4337 flow cho guest user.
 */
export function mapGuestTransactionStatusToVietnamese(statusValue: GuestTransactionStatus): string {
  switch (statusValue) {
    case 'idle': return 'Sẵn sàng';
    case 'decrypting': return 'Đang giải mã khóa ví...';
    case 'building': return 'Đang xây dựng giao dịch...';
    case 'paymaster': return 'Đang yêu cầu tài trợ gas...';
    case 'submitting': return 'Đang gửi lên blockchain...';
    case 'indexing': return 'Đang ghi nhận vào hệ thống...';
    case 'success': return 'Thành công';
    case 'failed': return 'Thất bại';
  }
}

/**
 * Hàm chuyển GuestDonationStatus (internal) sang GuestTransactionStatus (UI).
 * Không dùng useCallback/useMemo — pure function đơn giản O(1), overhead không đáng kể.
 */
export function resolveGuestDisplayStatusRaw(
  status: string,
): GuestTransactionStatus {
  switch (status) {
    case 'IDLE': return 'idle';
    case 'DECRYPTING_KEY': return 'decrypting';
    case 'BUILDING_USER_OP': return 'building';
    case 'REQUESTING_PAYMASTER': return 'paymaster';
    case 'SUBMITTING_BUNDLER': return 'submitting';
    case 'INDEXING': return 'indexing';
    case 'SUCCESS': return 'success';
    case 'FAILED': return 'failed';
    default: return 'idle';
  }
}

/**
 * Hàm map lỗi donation sang thông điệp dễ hiểu.
 * Mục đích: phân loại lỗi rõ ràng cho luồng one-click donation và API record backend.
 */
export function mapDonationErrorMessage(error: unknown): string {
  const apiError = error as ApiErrorResponse;
  if (apiError?.statusCode === 401) return 'Bạn chưa đăng nhập hoặc phiên đã hết hạn. Vui lòng đăng nhập lại để ghi nhận quyên góp.';
  if (apiError?.errorCode === 'CHAIN_MISMATCH') return 'Hệ thống backend đang ở sai mạng blockchain. Vui lòng thử lại sau.';
  if (apiError?.errorCode === 'TRANSACTION_TIMEOUT') return 'Giao dịch đang pending quá lâu. Vui lòng đợi thêm hoặc thử lại sau.';
  if (apiError?.errorCode === 'TRANSACTION_REVERTED') return 'Giao dịch bị từ chối trên blockchain. Vui lòng kiểm tra lại số dư token.';
  if (apiError?.errorCode === 'PAYMASTER_POLICY_MISMATCH') return 'Hệ thống tài trợ phí gas chưa cấu hình policy phù hợp cho giao dịch quyên góp. Vui lòng liên hệ quản trị viên.';
  if (apiError?.errorCode === 'VALIDATION_ERROR') {
    return apiError.message || 'Dữ liệu ghi nhận quyên góp không hợp lệ. Vui lòng kiểm tra lại thông tin.';
  }
  return apiError?.message || (error as Error)?.message || 'Không thể xử lý quyên góp lúc này. Vui lòng thử lại sau.';
}
