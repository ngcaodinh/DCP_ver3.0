import type { Metadata } from 'next';
import { Suspense, type ReactElement } from 'react';
import OrganizationFeedbackPageClient from './OrganizationFeedbackPageClient';

export const metadata: Metadata = {
  title: 'Quản lý feedback | DCP',
  description: 'Quản lý, thống kê và xuất feedback của tổ chức'
};

/** Server Component mỏng giữ metadata và Suspense boundary cho trang organization feedback. */
export default function OrganizationFeedbackPage(): ReactElement {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang tải trang feedback...</div>}>
      <OrganizationFeedbackPageClient />
    </Suspense>
  );
}
