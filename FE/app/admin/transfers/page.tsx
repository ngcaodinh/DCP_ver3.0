import type { Metadata } from 'next';
import AdminTransfersPageClient from './AdminTransfersPageClient';

export const metadata: Metadata = {
  title: 'Admin Transfer Queue | DCP',
  description: 'Quản lý hàng chờ chuyển khoản thủ công — Decentralized Charity Platform'
};

/**
 * Trang Admin Transfer Queue — /admin/transfers
 * Hiển thị toàn bộ transfer đang xử lý, thất bại, và cần manual review.
 * Real-time cập nhật qua Socket.io.
 */
export default function AdminTransfersPage() {
  return <AdminTransfersPageClient />;
}
