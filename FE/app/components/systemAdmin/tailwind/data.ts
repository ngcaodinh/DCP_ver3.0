// =============================================================================
// Cấu hình Navigation cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/data.ts
// Mục đích: Cung cấp cấu hình điều hướng cho trang Admin (không còn mock data — chuyển sang real API)
// =============================================================================

import type { NavigationItem } from './types';

// =============================================================================
// NAVIGATION ITEMS
// =============================================================================

/** Danh sách quyền điều hướng được cấp cho Admin, chỉ gồm các chức năng có API hoặc trang vận hành tương ứng. */
const ADMIN_NAVIGATION_ITEM_LIST: readonly NavigationItem[] = [
  {
    key: 'dashboard',
    label: 'Tổng quan',
    iconPath: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  },
  {
    key: 'systemErrorLog',
    label: 'Log lỗi hệ thống',
    iconPath: 'M12 9v2m0 4h.01m-7.938 4h15.876c1.38 0 2.243-1.495 1.553-2.688L13.553 4.688a1.75 1.75 0 00-3.106 0L2.509 16.312C1.819 17.505 2.682 19 4.062 19z',
  },
  {
    key: 'sybilManagement',
    label: 'Quản lý Sybil',
    iconPath: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  {
    key: 'transferQueue',
    label: 'Hàng chờ chuyển khoản',
    iconPath: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    key: 'committeeSeats',
    label: 'Ghế Ủy ban',
    iconPath: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0H5z',
  },
  {
    key: 'feedbackFlagging',
    label: 'Feedback bị gắn cờ',
    iconPath: 'M7 8h10M7 12h6m-9 8 3.5-3.5h9A2.5 2.5 0 0019 14V6a2.5 2.5 0 00-2.5-2.5h-9A2.5 2.5 0 005 6v14z',
  },
];

/** Trả về bản sao danh sách điều hướng để component gọi không thể thay đổi quyền hiển thị dùng chung. */
export function getNavigationItems(): NavigationItem[] {
  return [...ADMIN_NAVIGATION_ITEM_LIST];
}


