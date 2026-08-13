'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AuditLogTable } from '@/app/components/adminAuditLogs/AuditLogTable';
import {
  AUDIT_LOG_ACTIONS,
  type AuditLogAction,
  type AuditLogListResponse
} from '@/app/components/adminAuditLogs/types';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

interface AuditLogFilters {
  actionType: AuditLogAction | '';
  adminId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditLogFilters = { actionType: '', adminId: '', from: '', to: '' };
const MAX_PAGE = 10_000;

/** Trang admin chỉ bật query sau khi đã xác nhận access token và role ở browser session. */
export default function AuditLogsPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilters = useMemo(() => readFiltersFromUrl(searchParams), [searchParams]);
  const initialPage = useMemo(() => readPageFromUrl(searchParams), [searchParams]);
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'denied'>('checking');
  const [accessToken, setAccessToken] = useState('');
  const [page, setPage] = useState(initialPage);
  const [draftFilters, setDraftFilters] = useState<AuditLogFilters>(initialFilters);
  const [filters, setFilters] = useState<AuditLogFilters>(initialFilters);

  useEffect(() => {
    const nextFilters = readFiltersFromUrl(searchParams);
    setPage(readPageFromUrl(searchParams));
    setFilters(nextFilters);
    setDraftFilters(nextFilters);
  }, [searchParams]);

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      setAuthState('denied');
      return;
    }
    if (session.userRole !== 'admin') {
      router.replace('/unauthorized');
      setAuthState('denied');
      return;
    }
    setAccessToken(session.accessToken);
    setAuthState('ready');
  }, [router]);

  const queryKey = useMemo(() => ['admin-audit-logs', page, filters], [page, filters]);
  const auditLogsQuery = useQuery({
    queryKey,
    enabled: authState === 'ready' && Boolean(accessToken),
    retry: false,
    queryFn: async (): Promise<AuditLogListResponse> => {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filters.actionType) params.set('actionType', filters.actionType);
      if (filters.adminId.trim()) params.set('adminId', filters.adminId.trim());
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);

      const response = await fetchApi<AuditLogListResponse>(
        buildApiUrl(`/api/audit-logs?${params.toString()}`),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return response.data;
    }
  });

  const errorMessage = getErrorMessage(auditLogsQuery.error);
  const data = auditLogsQuery.data;

  useEffect(() => {
    if (!data || data.totalPages <= 0 || page <= data.totalPages) return;
    const validPage = Math.min(MAX_PAGE, Math.max(1, data.totalPages));
    // Deep-link vượt tổng trang phải được chuẩn hóa trước khi người dùng tiếp tục thao tác.
    setPage(validPage);
    replaceUrl(router, validPage, filters);
  }, [data, filters, page, router]);

  const submitFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextFilters = { ...draftFilters, adminId: draftFilters.adminId.trim().slice(0, 200) };
    setPage(1);
    setFilters(nextFilters);
    replaceUrl(router, 1, nextFilters);
  };

  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
    replaceUrl(router, 1, EMPTY_FILTERS);
  };

  if (authState === 'checking') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</div>;
  }
  if (authState === 'denied') return null;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <nav className="mb-2 text-xs text-slate-400">
          <a href="/admin" className="hover:text-slate-600">Admin</a>
          <span className="mx-1.5">›</span>
          <span className="font-medium text-slate-600">Audit Logs</span>
        </nav>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Admin Audit Logs</h1>
            <p className="mt-1 text-sm text-slate-500">Tra cứu các hành động admin có kiểm soát, không hiển thị dữ liệu PII nhạy cảm.</p>
          </div>
          <button
            type="button"
            onClick={() => void auditLogsQuery.refetch()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Làm mới
          </button>
        </div>

        <form onSubmit={submitFilters} className="mb-5 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-5">
          <label className="text-sm text-slate-700">
            Action
            <select
              aria-label="Lọc theo action"
              value={draftFilters.actionType}
              onChange={(event) => setDraftFilters((previous) => ({ ...previous, actionType: event.target.value as AuditLogAction | '' }))}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            >
              <option value="">Tất cả action</option>
              {AUDIT_LOG_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-700">
            Admin ID
            <input
              aria-label="Lọc theo admin ID"
              value={draftFilters.adminId}
              onChange={(event) => setDraftFilters((previous) => ({ ...previous, adminId: event.target.value }))}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
              placeholder="admin-..."
            />
          </label>
          <label className="text-sm text-slate-700">
            Từ ngày
            <input aria-label="Ngày bắt đầu" type="date" value={draftFilters.from} onChange={(event) => setDraftFilters((previous) => ({ ...previous, from: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm" />
          </label>
          <label className="text-sm text-slate-700">
            Đến ngày
            <input aria-label="Ngày kết thúc" type="date" value={draftFilters.to} onChange={(event) => setDraftFilters((previous) => ({ ...previous, to: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm" />
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">Áp dụng</button>
            <button type="button" onClick={clearFilters} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Xóa lọc</button>
          </div>
        </form>

        {auditLogsQuery.isLoading && <AuditLogSkeleton />}
        {errorMessage && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>{errorMessage}</p>
            <button type="button" onClick={() => void auditLogsQuery.refetch()} className="mt-2 font-medium underline">Thử lại</button>
          </div>
        )}
        {!auditLogsQuery.isLoading && !errorMessage && data && (
          <>
            <AuditLogTable items={data.items} />
            <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
              <span>{data.total} bản ghi</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={page <= 1} onClick={() => { const nextPage = Math.max(1, page - 1); setPage(nextPage); replaceUrl(router, nextPage, filters); }} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Trước</button>
                <span>Trang {data.page} / {Math.max(data.totalPages, 1)}</span>
                <button type="button" disabled={page >= data.totalPages} onClick={() => { const nextPage = Math.min(MAX_PAGE, page + 1); setPage(nextPage); replaceUrl(router, nextPage, filters); }} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Sau</button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function AuditLogSkeleton() {
  return <div aria-label="Đang tải audit logs" className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded bg-slate-100" />)}</div>;
}

function getErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as ApiErrorResponse).message === 'string') {
    return (error as ApiErrorResponse).message;
  }
  return 'Không thể tải audit log. Vui lòng thử lại.';
}

/** Đọc filter đã apply từ URL để refresh/back-forward giữ nguyên màn hình audit. */
function readFiltersFromUrl(searchParams: Readonly<URLSearchParams>): AuditLogFilters {
  const actionType = searchParams.get('actionType') ?? '';
  return {
    actionType: AUDIT_LOG_ACTIONS.includes(actionType as AuditLogAction) ? actionType as AuditLogAction : '',
    adminId: (searchParams.get('adminId') ?? '').slice(0, 200),
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? ''
  };
}

/** Parse page URL có giới hạn để không tạo query state ngoài contract API. */
function readPageFromUrl(searchParams: Readonly<URLSearchParams>): number {
  const parsed = Number(searchParams.get('page') ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_PAGE) : 1;
}

/** Đồng bộ filter/page đã apply vào URL mà không reload toàn trang. */
function replaceUrl(router: ReturnType<typeof useRouter>, page: number, filters: AuditLogFilters): void {
  const params = new URLSearchParams({ page: String(page), limit: '20' });
  if (filters.actionType) params.set('actionType', filters.actionType);
  if (filters.adminId) params.set('adminId', filters.adminId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  router.replace(`/admin/audit-logs?${params.toString()}`, { scroll: false });
}
