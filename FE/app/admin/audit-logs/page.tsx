import type { Metadata } from 'next';
import { Suspense } from 'react';
import AuditLogsPageClient from './AuditLogsPageClient';

export const metadata: Metadata = {
  title: 'Admin Audit Logs | DCP',
  description: 'Tra cứu audit log admin canonical của DCP'
};

export default function AdminAuditLogsPage() {
  return <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang tải audit logs...</div>}><AuditLogsPageClient /></Suspense>;
}
