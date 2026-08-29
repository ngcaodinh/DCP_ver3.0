import type { AuditorPayoutStatus, AuditorWalletLock } from '../utils/auditorPortalApi';
import { formatVnd } from '../components/transparency/format';

export const AUDITOR_WALLET_LOCK_LABEL: Record<AuditorWalletLock, string> = { UNSTAKING: 'Đang xử lý yêu cầu rút cọc', WITHDRAWING: 'Đang rút cọc', PAYOUT_IN_FLIGHT: 'Đang chuyển tiền về ngân hàng', DEBT_SETTLING: 'Đang cấn trừ nợ phạt', ACCOUNT_UPDATING: 'Đang cập nhật tài khoản nhận tiền' };
export const AUDITOR_PAYOUT_STATUS_LABEL: Record<AuditorPayoutStatus, string> = { PENDING: 'Chờ xử lý', TRANSFERRING: 'Đang chuyển khoản', TRANSFERRED: 'Đã chuyển thành công', BURNED: 'Đã đối soát xong', FAILED: 'Chuyển khoản thất bại', MANUAL_REVIEW: 'Cần đối soát thủ công', CANCELLED: 'Đã huỷ' };
export const ARBITRATION_OUTCOME_LABEL: Record<'PENDING' | 'REJECT_PROJECT' | 'UPHOLD_PROJECT' | 'NO_CONSENSUS' | 'TIMEOUT' | 'NONE', string> = { PENDING: 'Đang chờ Ủy ban Điều hành xét xử', REJECT_PROJECT: 'Khiếu nại được chấp nhận — dự án bị từ chối', UPHOLD_PROJECT: 'Khiếu nại bị bác — dự án được giữ', NO_CONSENSUS: 'Ủy ban không đạt đồng thuận', TIMEOUT: 'Hết hạn xét xử, không đủ phiếu', NONE: 'Chưa mở vụ xét xử' };
/** Định dạng VND dùng chung cho số tiền portal. */
export function formatVndAmount(amount: number): string { return `${formatVnd(amount)} VNĐ`; }

/** Định dạng thời điểm portal Auditor theo locale Việt Nam và xử lý rõ giá trị chưa có. */
export function formatAuditorDateTime(value: Date | string | null): string {
  return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa xác định';
}
