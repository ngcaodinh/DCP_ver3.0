'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TransferStatusPanel from '@/app/components/adminTransfers/TransferStatusPanel';
import ToastStack from '@/app/components/systemAdmin/tailwind/ToastStack';
import { readAuthSession } from '@/app/utils/authSession';
import type { ToastItem } from '@/app/components/systemAdmin/tailwind/types';

/** Trang client kiểm tra role trước khi mount dashboard để non-admin không gọi API queue. */
export default function AdminTransfersPageClient() {
  const router = useRouter();
  const [isAuthorised, setIsAuthorised] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      return;
    }
    if (session.userRole !== 'admin') {
      router.replace('/unauthorized');
      return;
    }
    setIsAuthorised(true);
    setIsCheckingAuth(false);
  }, [router]);

  /** Đưa toast từ dashboard vào stack dùng chung của khu vực admin. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((previousToasts) => [...previousToasts, { ...toast, id }]);
    window.setTimeout(() => setToasts((previousToasts) => previousToasts.filter((item) => item.id !== id)), 4_000);
  }, []);

  /** Xóa một toast sau khi admin đóng thủ công. */
  const removeToast = useCallback((toastId: string) => {
    setToasts((previousToasts) => previousToasts.filter((item) => item.id !== toastId));
  }, []);

  if (isCheckingAuth) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</div>;
  }
  if (!isAuthorised) return null;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <nav className="mb-2 text-xs text-slate-400">
            <a href="/admin" className="hover:text-slate-600">Admin</a>
            <span className="mx-1.5">›</span>
            <span className="font-medium text-slate-600">Transfer Queue</span>
          </nav>
          <h1 className="text-2xl font-bold text-slate-900">Admin Transfer Queue</h1>
          <p className="mt-1 text-sm text-slate-500">Quản lý hàng chờ manual review theo dữ liệu server và trạng thái SLA realtime.</p>
        </div>
        <TransferStatusPanel onPushToast={addToast} />
      </div>
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}
