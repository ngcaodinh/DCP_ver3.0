// =============================================================================
// Helpers cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/helpers.ts
// Mục đích: Các hàm utility dùng chung trong trang Admin
// =============================================================================

import type { PageKey, SybilRiskLevel } from './types';

// =============================================================================
// PAGE TITLE
// =============================================================================

/** Trả về title hiển thị theo page key. */
export function getPageTitle(key: PageKey): string {
  const titles: Record<PageKey, string> = {
    dashboard: 'Tổng quan hệ thống',
    disbursement: 'Ký duyệt Giải ngân',
    kyc: 'Duyệt Hồ sơ KYC',
    bankAccountApproval: 'Duyệt tài khoản ngân hàng',
    systemErrorLog: 'Log lỗi hệ thống',
    report: 'Báo cáo Tuân thủ',
    transparency: 'Tra cứu Giao dịch',
    sybilManagement: 'Quản lý Sybil Attack',
    transferQueue: 'Hàng chờ chuyển khoản',
    feedbackFlagging: 'Feedback bị flag',
    committeeSeats: 'Ghế Ủy ban',
  };
  return titles[key] ?? 'Không xác định';
}

// =============================================================================
// DEADLINE UTILITY
// =============================================================================

/** Trả về class màu cho deadline badge. */
export function getDeadlineClass(className: 'urgent' | 'normal' | 'ok'): string {
  switch (className) {
    case 'urgent':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'normal':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'ok':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
}

// =============================================================================
// STATUS BADGE UTILITY
// =============================================================================

/** Trả về class màu cho status badge. */
export function getStatusBadgeClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'pending':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'rejected':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'submitted':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

// =============================================================================
// HASH / ADDRESS UTILITY
// =============================================================================

/** Cắt ngắn hash/address, hiển thị 6 ký tự đầu + ... + 4 ký tự cuối. */
export function getShortHash(hash: string): string {
  if (!hash || hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

/** Cắt ngắn wallet address, hiển thị 6 ký tự đầu + ... + 4 ký tự cuối. */
export function getShortWalletAddress(address: string): string {
  if (!address || address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// =============================================================================
// SYBIL UTILITY
// =============================================================================

/** Trả về class màu cho risk level badge. */
export function getSybilRiskLevelClass(level: SybilRiskLevel): string {
  switch (level) {
    case 'critical':
      return 'border-red-300 bg-red-50 text-red-700';
    case 'high':
      return 'border-orange-300 bg-orange-50 text-orange-700';
    case 'medium':
      return 'border-yellow-300 bg-yellow-50 text-yellow-700';
    case 'low':
      return 'border-emerald-200 bg-emerald-50 text-emerald-600';
  }
}

/** Trả về thông tin badge cho Sybil status. */
export function getSybilStatusClass(isSybil: boolean): { label: string; badgeClass: string } {
  if (isSybil) {
    return {
      label: 'Sybil',
      badgeClass: 'border-red-300 bg-red-50 text-red-700',
    };
  }
  return {
    label: 'Bình thường',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  };
}

/** Trả về class màu cho thanh điểm rủi ro (0-100). */
export function getRiskScoreBarClass(score: number): string {
  if (score >= 80) return 'bg-red-500';
  if (score >= 50) return 'bg-orange-400';
  if (score >= 25) return 'bg-yellow-400';
  return 'bg-emerald-400';
}

// =============================================================================
// FORMATTING UTILITY
// =============================================================================

/** Format số tiền VNĐ — thêm dấu chấm phân cách hàng nghìn. */
export function formatVndAmount(amount: number): string {
  return new Intl.NumberFormat('vi-VN').format(amount) + '₫';
}

/** Format date/time theo locale Việt Nam. */
export function formatVietnameseDateTime(dateStr: string): string {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return dateStr;
  }
}
