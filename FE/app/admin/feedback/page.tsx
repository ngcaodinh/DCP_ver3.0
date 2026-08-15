import type { Metadata } from 'next';
import { Suspense, type ReactElement } from 'react';
import FeedbackFlaggingPageClient from './FeedbackFlaggingPageClient';

export const metadata: Metadata = {
  title: 'Feedback Flagging Panel | DCP',
  description: 'Review và moderation feedback bị flag của DCP'
};

/** Trang server mỏng để giữ metadata và boundary Suspense cho query params phía client. */
export default function AdminFeedbackPage(): ReactElement {
  return <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang tải feedback panel...</div>}><FeedbackFlaggingPageClient /></Suspense>;
}
