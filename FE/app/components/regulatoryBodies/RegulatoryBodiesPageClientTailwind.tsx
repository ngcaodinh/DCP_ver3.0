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
import { navigationItemList } from './tailwind/data';
import { getPageTitle } from './tailwind/helpers';
import type { PageKey, ToastItem } from './tailwind/types';

/** Cổng Regulatory giữ nghiệp vụ giám sát; quyết định giải ngân và GPS chỉ còn ở cổng Ủy ban. */
export default function RegulatoryBodiesPageClientTailwind() {
  const router = useRouter();
  const [isAuthorised, setIsAuthorised] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activePage, setActivePage] = useState<PageKey>('dashboard');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [userDisplayName, setUserDisplayName] = useState('Cơ quan giám sát');
  const [userEmail, setUserEmail] = useState('');
  const [userWalletAddress, setUserWalletAddress] = useState('');

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      return;
    }
    if (session.userRole !== 'regulatory') {
      router.replace('/unauthorized');
      return;
    }
    setUserDisplayName(session.userFullName || 'Cơ quan giám sát');
    setUserEmail(session.userEmail || '');
    setUserWalletAddress(session.userWalletAddress || '');
    setIsAuthorised(true);
    setIsLoading(false);
  }, [router]);

  /** Hiển thị kết quả thao tác nghiệp vụ ngắn hạn. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    const id = String(Date.now());
    setToasts(previous => [...previous, { ...toast, id }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 4_000);
  }, []);

  /** Xóa session Regulatory sau khi người dùng đã xác nhận và quay lại cổng đăng nhập. */
  const handleConfirmedLogout = useCallback((): void => {
    clearAuthSession();
    router.replace('/login');
  }, [router]);

  const { requestLogout, logoutConfirmationDialog } = useLogoutConfirmation(handleConfirmedLogout);

  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập…</div>;
  if (!isAuthorised) return null;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <div className="hidden lg:block"><Sidebar selectedPageKey={activePage} navigationItemList={navigationItemList.filter(item => item.key !== 'disbursement')} onSelectPage={setActivePage} onLogout={requestLogout} /></div>
      <section className="flex-1 p-0">
        <Topbar breadcrumbTitle={getPageTitle(activePage)} userDisplayName={userDisplayName} userEmail={userEmail} userWalletAddress={userWalletAddress} notificationContent={<NotificationBell />} onOpenMobileMenu={() => undefined} onLogout={requestLogout} />
        <div className="space-y-5 p-4 lg:p-7">
          <header><h1 className="text-2xl font-bold">{getPageTitle(activePage)}</h1><p className="mt-1 text-xs text-slate-500">Giám sát tuân thủ và vận hành</p></header>
          {activePage === 'dashboard' ? (
            <section className="max-w-3xl rounded-xl border border-violet-200 bg-violet-50 p-6">
              <h2 className="text-lg font-semibold text-violet-950">Quyền quyết định giải ngân đã chuyển giao</h2>
              <p className="mt-2 text-sm leading-6 text-violet-900">Cơ quan giám sát tiếp tục duyệt hồ sơ, KYC và theo dõi tuân thủ. Bỏ phiếu giải ngân hoặc ghi đè GPS không còn là chức năng hợp lệ của cổng này.</p>
            </section>
          ) : <NonDashboardPanel selectedPageKey={activePage} accessToken={readAuthSession().accessToken || undefined} onPushToast={(titleText, bodyText, tone) => addToast({ titleText, bodyText, tone })} />}
        </div>
      </section>
      <ToastStack toastItemList={toasts} onCloseToast={(id) => setToasts(previous => previous.filter(item => item.id !== id))} />
      {logoutConfirmationDialog}
    </main>
  );
}
