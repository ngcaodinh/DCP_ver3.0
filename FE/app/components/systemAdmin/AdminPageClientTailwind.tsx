'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import NotificationBell from '@/app/components/notifications/NotificationBell';
import { useLogoutConfirmation } from '@/app/hooks/useLogoutConfirmation';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import NonDashboardPanel from './tailwind/NonDashboardPanel';
import Sidebar from './tailwind/Sidebar';
import ToastStack from './tailwind/ToastStack';
import Topbar from './tailwind/Topbar';
import { getNavigationItems } from './tailwind/data';
import { getPageTitle } from './tailwind/helpers';
import type { PageKey, ToastItem } from './tailwind/types';

/** Cổng vận hành Admin chỉ cung cấp chức năng thuộc quyền Admin, tách khỏi quyết định của Ủy ban Điều hành. */
export default function AdminPageClientTailwind() {
  const router = useRouter();
  const [authVerified, setAuthVerified] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [activePage, setActivePage] = useState<PageKey>('dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
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

  /** Hiển thị trạng thái thao tác ngắn hạn mà không lưu dữ liệu nhạy cảm vào client store. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    const id = String(Date.now());
    setToasts(previous => [...previous, { ...toast, id }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 4_000);
  }, []);

  /** Xóa toast sau khi người vận hành đã đọc hoặc đóng thông báo. */
  const removeToast = useCallback((id: string): void => {
    setToasts(previous => previous.filter(item => item.id !== id));
  }, []);

  /** Kết thúc phiên Admin sau khi người dùng đã xác nhận và quay về cổng DAO. */
  const handleConfirmedLogout = useCallback((): void => {
    clearAuthSession();
    router.replace('/governance/login');
  }, [router]);

  const { requestLogout, logoutConfirmationDialog } = useLogoutConfirmation(handleConfirmedLogout);

  /** Mở sidebar dạng drawer để mọi chức năng được truy cập trên màn hình nhỏ. */
  const handleOpenMobileMenu = useCallback((): void => {
    setIsMobileMenuOpen(true);
  }, []);

  /** Đóng drawer khi người dùng đã chọn chức năng hoặc chạm ra ngoài vùng menu. */
  const handleCloseMobileMenu = useCallback((): void => {
    setIsMobileMenuOpen(false);
  }, []);

  if (authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập…</div>;
  }
  if (!authVerified) return null;

  const navigationItemList = getNavigationItems();
  const isDashboard = activePage === 'dashboard';
  const pageDescription = activePage === 'committeeSeats'
    ? 'Thiết lập và theo dõi danh sách Chủ tịch, Ủy viên trong giai đoạn bootstrap.'
    : 'Quản lý và giám sát vận hành hệ thống.';

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <div className="hidden lg:block">
        <Sidebar selectedPageKey={activePage} navigationItemList={navigationItemList} onSelectPage={setActivePage} />
      </div>

      {isMobileMenuOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" aria-label="Đóng menu điều hướng" onClick={handleCloseMobileMenu} className="absolute inset-0 bg-slate-950/45" />
          <div role="dialog" aria-modal="true" aria-label="Menu điều hướng Admin" className="relative h-full w-[252px] shadow-2xl">
            <Sidebar
              selectedPageKey={activePage}
              navigationItemList={navigationItemList}
              onSelectPage={setActivePage}
              onCloseMobileMenu={handleCloseMobileMenu}
            />
          </div>
        </div>
      ) : null}

      <section className="min-w-0 flex-1">
        <Topbar
          breadcrumbTitle={getPageTitle(activePage)}
          userDisplayName={userDisplayName}
          userEmail={userEmail}
          userWalletAddress={userWalletAddress}
          notificationContent={<NotificationBell />}
          onOpenMobileMenu={handleOpenMobileMenu}
          onLogout={requestLogout}
        />
        <div className="space-y-5 p-4 sm:p-5 lg:p-7">
          <header>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{getPageTitle(activePage)}</h1>
            <p className="mt-1 text-xs leading-5 text-slate-500 sm:text-sm">{pageDescription}</p>
          </header>
          {isDashboard ? (
            <section className="max-w-3xl rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-6" aria-label="Phạm vi quyền quản trị">
              <h2 className="text-base font-semibold text-emerald-950 sm:text-lg">Phạm vi quyền Admin</h2>
              <p className="mt-2 text-sm leading-6 text-emerald-900">
                Ủy ban Điều hành quyết định giải ngân và xử lý cảnh báo vị trí. Admin phụ trách KYC, tài khoản ngân hàng, hàng chờ chuyển khoản, Sybil, log hệ thống, phản hồi bị gắn cờ và thiết lập ghế trong giai đoạn bootstrap.
              </p>
            </section>
          ) : (
            <NonDashboardPanel activePage={activePage} onPushToast={addToast} />
          )}
        </div>
      </section>
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
      {logoutConfirmationDialog}
    </main>
  );
}
