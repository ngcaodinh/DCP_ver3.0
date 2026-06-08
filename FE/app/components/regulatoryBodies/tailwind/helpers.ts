import type { PageKey } from './types';

/** Hàm chuẩn hóa tiêu đề để đồng bộ breadcrumb, header và tiêu đề trang. */
export function getPageTitle(pageKey: PageKey): string {
  if (pageKey === 'dashboard') return 'Tổng quan Giám sát';
  if (pageKey === 'projectReview') return 'Duyệt dự án mới';
  if (pageKey === 'disbursement') return 'Ký duyệt Giải ngân';
  if (pageKey === 'kyc') return 'Duyệt Hồ sơ KYC';
  if (pageKey === 'bankAccountApproval') return 'Duyệt tài khoản ngân hàng';
  if (pageKey === 'report') return 'Báo cáo Tuân thủ';
  if (pageKey === 'sybilManagement') return 'Quản lý Sybil Attack';
  return 'Tra cứu Giao dịch';
}

/** Hàm lấy lớp màu cho trạng thái hạn xử lý để người dùng nhận biết mức ưu tiên nhanh hơn. */
export function getDeadlineClass(deadlineLevel: 'urgent' | 'normal' | 'ok'): string {
  if (deadlineLevel === 'urgent') return 'bg-red-100 text-red-600';
  if (deadlineLevel === 'normal') return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}

/** Hàm ánh xạ badge trạng thái cho bảng audit để hiển thị đồng nhất toàn trang. */
export function getStatusBadgeClass(statusText: string): string {
  if (statusText === 'Đã ký') return 'bg-emerald-100 text-emerald-700';
  if (statusText === 'Chờ ký') return 'bg-amber-100 text-amber-700';
  if (statusText === 'Bị từ chối') return 'bg-red-100 text-red-600';
  return 'bg-slate-100 text-slate-600';
}

/** Hàm cắt chuỗi hash dài để bảng giữ được bố cục đẹp trên mọi kích thước màn hình. */
export function getShortHash(transactionId: string): string {
  if (transactionId.length < 12) return transactionId;
  return `${transactionId.slice(0, 8)}...${transactionId.slice(-4)}`;
}

/** Hàm cắt địa chỉ ví dài để hiển thị gọn trong bảng. */
export function getShortWalletAddress(walletAddress: string): string {
  if (walletAddress.length < 20) return walletAddress;
  return `${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}`;
}

/** Hàm lấy lớp màu cho mức độ rủi ro Sybil. */
export function getSybilRiskLevelClass(riskLevel: string): string {
  if (riskLevel === 'critical') return 'bg-red-100 text-red-700 border border-red-200';
  if (riskLevel === 'high') return 'bg-amber-100 text-amber-700 border border-amber-200';
  if (riskLevel === 'medium') return 'bg-yellow-100 text-yellow-700 border border-yellow-200';
  return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
}

/** Hàm lấy icon/màu cho badge trạng thái isSybil. */
export function getSybilStatusClass(isSybil: boolean): { badgeClass: string; label: string } {
  if (isSybil) {
    return { badgeClass: 'bg-red-100 text-red-700 border border-red-200', label: 'Sybil' };
  }
  return { badgeClass: 'bg-emerald-100 text-emerald-700 border border-emerald-200', label: 'Bình thường' };
}

/** Hàm lấy màu cho thanh điểm rủi ro. */
export function getRiskScoreBarClass(score: number): string {
  if (score >= 70) return 'bg-red-500';
  if (score >= 40) return 'bg-amber-500';
  if (score >= 20) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

/** Hàm định dạng số tiền VND để hiển thị trong bảng. */
export function formatVndAmount(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

/** Hàm định dạng ngày giờ tiếng Việt. */
export function formatVietnameseDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

