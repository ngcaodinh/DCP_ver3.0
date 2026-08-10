'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import DLQManagement from '@/app/components/adminSbtRetry/DLQManagement';
import ToastStack from '@/app/components/systemAdmin/tailwind/ToastStack';
import type { ToastItem } from '@/app/components/systemAdmin/tailwind/types';
import { readAuthSession } from '@/app/utils/authSession';

/** Client shell kiểm tra role trước khi mount giao diện DLQ để non-admin không gọi API. */
export default function SbtRetryPageClient(): ReactElement | null {
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

  /** Thêm toast vào stack admin và tự động dọn sau thời gian hiển thị chuẩn. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((previousToasts) => [...previousToasts, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((previousToasts) => previousToasts.filter((item) => item.id !== id));
    }, 4_000);
  }, []);

  /** Xóa toast khi admin đóng thủ công. */
  const removeToast = useCallback((toastId: string): void => {
    setToasts((previousToasts) => previousToasts.filter((item) => item.id !== toastId));
  }, []);

  if (isCheckingAuth) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</div>;
  }
  if (!isAuthorised) return null;

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <nav className="mb-2 text-xs text-slate-400">
            <a href="/admin" className="hover:text-slate-600">Admin</a>
            <span className="mx-1.5">›</span>
            <span className="font-medium text-slate-600">SBT Mint Retry</span>
          </nav>
          <h1 className="text-2xl font-bold text-slate-900">SBT Mint Retry</h1>
          <p className="mt-1 text-sm text-slate-500">Theo dõi và chạy lại các job mint SBT đã vào dead-letter queue.</p>
        </div>
        <DLQManagement onPushToast={addToast} />
      </div>
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}
