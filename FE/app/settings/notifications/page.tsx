import type { ReactElement } from 'react';
import NotificationPanel from '@/app/components/notifications/NotificationPanel';

/** Hiển thị route cài đặt notification độc lập, không áp đặt thêm global header hoặc role policy. */
export default function NotificationSettingsPage(): ReactElement {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Cài đặt thông báo</h1>
        <p className="mt-2 text-sm text-slate-600">Quản lý các email quan trọng từ Decentralized Charity Platform.</p>
        <div className="mt-6">
          <NotificationPanel />
        </div>
      </div>
    </main>
  );
}
