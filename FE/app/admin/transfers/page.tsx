import type { Metadata } from 'next';
import TransferStatusPanel from '@/app/components/adminTransfers/TransferStatusPanel';

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
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <nav className="mb-2 text-xs text-slate-400">
            <a href="/admin" className="hover:text-slate-600">Admin</a>
            <span className="mx-1.5">›</span>
            <span className="text-slate-600 font-medium">Transfer Queue</span>
          </nav>
          <h1 className="text-2xl font-bold text-slate-900">Admin Transfer Queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Quản lý các yêu cầu giải ngân đang retry, thất bại, và cần xử lý tay.
          </p>
        </div>
        <TransferStatusPanel />
      </div>
    </main>
  );
}
