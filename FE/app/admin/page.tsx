import type { Metadata } from 'next';
import AdminPageClientTailwind from '../components/systemAdmin/AdminPageClientTailwind';

export const metadata: Metadata = {
  title: 'Cổng Quản trị Hệ thống | DCP',
  description: 'Trang quản trị hệ thống Decentralized Charity Platform',
};

/**
 * Hàm trang Quản trị Admin.
 * Mục đích: render giao diện Admin full-screen bằng component cô lập.
 */
export default function AdminPage() {
  return <AdminPageClientTailwind />;
}
