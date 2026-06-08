// =============================================================================
// Cấu hình Navigation cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/data.ts
// Mục đích: Cung cấp cấu hình điều hướng cho trang Admin (không còn mock data — chuyển sang real API)
// =============================================================================

import type { NavigationItem, PageKey } from './types';

// =============================================================================
// NAVIGATION ITEMS
// =============================================================================

/** Danh sách mục điều hướng cho sidebar — context: Admin. */
export function getNavigationItems(): NavigationItem[] {
  return [
    {
      key: 'dashboard',
      label: 'Tổng quan',
      iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      key: 'projectReview',
      label: 'Duyệt dự án mới',
      badge: 2,
      iconPath: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      key: 'disbursement',
      label: 'Ký duyệt Giải ngân',
      badge: 3,
      iconPath: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      key: 'kyc',
      label: 'Duyệt Hồ sơ KYC',
      badge: 5,
      iconPath: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    },
    {
      key: 'bankAccountApproval',
      label: 'Duyệt tài khoản ngân hàng',
      badge: 0,
      iconPath: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    },
    {
      key: 'systemErrorLog',
      label: 'Log lỗi hệ thống',
      iconPath: 'M12 9v2m0 4h.01m-7.938 4h15.876c1.38 0 2.243-1.495 1.553-2.688L13.553 4.688a1.75 1.75 0 00-3.106 0L2.509 16.312C1.819 17.505 2.682 19 4.062 19z',
    },
    {
      key: 'report',
      label: 'Báo cáo Tuân thủ',
      iconPath: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      key: 'sybilManagement',
      label: 'Quản lý Sybil Attack',
      badge: 2,
      iconPath: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    },
  ];
}


