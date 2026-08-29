'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import NotificationBell from '@/app/components/notifications/NotificationBell';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import NonDashboardPanel from './tailwind/NonDashboardPanel';
import Sidebar from './tailwind/Sidebar';
import ToastStack from './tailwind/ToastStack';
import Topbar from './tailwind/Topbar';
import { getNavigationItems } from './tailwind/data';
import { getPageTitle } from './tailwind/helpers';
import type { PageKey, ToastItem } from './tailwind/types';

/** Cổng vận hành Admin: không còn hiển thị hoặc gọi luồng quyết định giải ngân/GPS đã chuyển sang Ủy ban. */
export default function AdminPageClientTailwind() {
  const router = useRouter();
  const [authVerified, setAuthVerified] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [activePage, setActivePage] = useState<PageKey>('dashboard');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [userDisplayName, setUserDisplayName] = useState('Quản trị viên');
  const [userEmail, setUserEmail] = useState('');
  const [userWalletAddress, setUserWalletAddress] = useState('');

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
    setUserDisplayName(session.userFullName || 'Quản trị viên');
    setUserEmail(session.userEmail || '');
    setUserWalletAddress(session.userWalletAddress || '');
    setAuthVerified(true);
    setAuthLoading(false);
  }, [router]);

  /** Hiển thị trạng thái thao tác vận hành ngắn hạn mà không giữ dữ liệu nhạy cảm ở client store. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    const id = String(Date.now());
    setToasts(previous => [...previous, { ...toast, id }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 4_000);
  }, []);

  /** Xoá toast đã được người vận hành đọc. */
  const removeToast = useCallback((id: string): void => {
    setToasts(previous => previous.filter(item => item.id !== id));
  }, []);

  /** Kết thúc phiên cục bộ trước khi điều hướng về cổng đăng nhập. */
  const handleLogout = useCallback((): void => {
    clearAuthSession();
    router.replace('/login');
  }, [router]);

  if (authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập…</div>;
  }
  if (!authVerified) return null;

  const navigationItemList = getNavigationItems();
  const isDashboard = activePage === 'dashboard';

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <div className="hidden lg:block">
        <Sidebar selectedPageKey={activePage} navigationItemList={navigationItemList} onSelectPage={setActivePage} onLogout={handleLogout} />
      </div>
      <section className="flex-1 p-0">
        <Topbar
          breadcrumbTitle={getPageTitle(activePage)}
          userDisplayName={userDisplayName}
          userEmail={userEmail}
          userWalletAddress={userWalletAddress}
          notificationContent={<NotificationBell />}
          onLogout={handleLogout}
        />
        <div className="space-y-5 p-4 lg:p-7">
          <header>
            <h1 className="text-2xl font-bold text-slate-900">{getPageTitle(activePage)}</h1>
            <p className="mt-1 text-xs text-slate-500">Quản lý và giám sát vận hành hệ thống</p>
          </header>
          {isDashboard ? (
            <section className="max-w-3xl rounded-xl border border-violet-200 bg-violet-50 p-6" aria-label="Thay đổi thẩm quyền quản trị">
              <h2 className="text-lg font-semibold text-violet-950">Thẩm quyền quyết định đã được chuyển giao</h2>
              <p className="mt-2 text-sm leading-6 text-violet-900">
                Từ 2026-08-27, Ủy ban Điều hành quyết định giải ngân và xem cảnh báo vị trí. Admin vẫn phụ trách KYC, tài khoản ngân hàng, hàng chờ chuyển khoản, Sybil, log và quản lý ghế giai đoạn đầu.
              </p>
              <button type="button" onClick={() => router.push('/governance/login')} className="mt-4 rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">
                Mở cổng Ủy ban
              </button>
            </section>
          ) : (
            <NonDashboardPanel activePage={activePage} onPushToast={addToast} />
          )}
        </div>
      </section>
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}
