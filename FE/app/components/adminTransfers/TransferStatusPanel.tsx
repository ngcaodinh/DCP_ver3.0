'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useManualReviewQueue, useManualReviewQueueCounts } from '@/app/hooks/useManualReviewQueue';
import { useTransferSocket, type TransferSocketEvent } from '@/app/hooks/useTransferSocket';
import type { ManualReviewQueueError, ManualReviewQueueItem, ManualReviewQueueParams } from '@/app/types/manualReview';
import CountdownTimer from './CountdownTimer';
import ManualReviewDialog from './ManualReviewDialog';

type TabKey = 'ALL' | 'EMERGENCY' | 'NORMAL' | 'OVERDUE';
type DialogState = { item: ManualReviewQueueItem; mode: 'approve' | 'reject' } | null;
type ToastTone = 'success' | 'error' | 'warning' | 'info';

type TransferStatusPanelProps = {
  onPushToast?: (toast: { titleText: string; bodyText: string; tone: ToastTone }) => void;
};

const PAGE_LIMIT = 50;
const QUEUE_REFRESH_DEBOUNCE_MS = 3_000;
const TAB_OPTIONS: { key: TabKey; label: string }[] = [
  { key: 'ALL', label: 'Tất cả' },
  { key: 'EMERGENCY', label: 'Khẩn cấp' },
  { key: 'NORMAL', label: 'Thường' },
  { key: 'OVERDUE', label: 'Quá hạn SLA' }
];

/** Chuyển tab UI thành filter server, không để client lọc trên trang hiện tại. */
function getTabParams(tab: TabKey, page: number, limit: number): ManualReviewQueueParams {
  if (tab === 'EMERGENCY') return { page, limit, requestMode: 'EMERGENCY' };
  if (tab === 'NORMAL') return { page, limit, requestMode: 'NORMAL' };
  if (tab === 'OVERDUE') return { page, limit, overdueOnly: true };
  return { page, limit };
}

/** Trả badge trạng thái theo DTO A3 để row luôn phản ánh server. */
function getStatusBadge(status: ManualReviewQueueItem['payosTransferStatus']): { label: string; className: string } {
  switch (status) {
    case 'PROCESSING': return { label: 'Đang xử lý', className: 'border-blue-200 bg-blue-100 text-blue-800' };
    case 'SUCCESS': return { label: 'Thành công', className: 'border-emerald-200 bg-emerald-100 text-emerald-800' };
    case 'FAILED': return { label: 'Thất bại', className: 'border-red-200 bg-red-100 text-red-800' };
    case 'MANUAL_REVIEW': return { label: 'Manual Review', className: 'border-amber-200 bg-amber-100 text-amber-800' };
    default: return { label: '—', className: 'border-slate-200 bg-slate-100 text-slate-600' };
  }
}

/** Rút gọn ID dài nhưng vẫn giữ phần đầu để admin đối chiếu nhanh. */
function shortenIdentifier(identifier: string): string {
  return identifier.length > 16 ? `${identifier.slice(0, 16)}...` : identifier;
}

/** Chuyển lỗi query thành nội dung hướng dẫn action rõ ràng cho admin. */
function getQueueErrorMessage(error: ManualReviewQueueError): string {
  switch (error.kind) {
    case 'UNAUTHENTICATED': return 'Phiên đăng nhập đã hết hạn hoặc authVersion đã thay đổi. Vui lòng đăng nhập lại.';
    case 'FORBIDDEN': return 'Tài khoản không còn quyền admin. Đang chuyển tới trang không được phép truy cập.';
    case 'RATE_LIMITED': return 'Dashboard đang bị giới hạn tần suất đọc, vui lòng thử lại sau.';
    case 'NETWORK': return 'Không thể kết nối tới dịch vụ manual review.';
    default: return 'Không thể tải danh sách manual review. Vui lòng thử lại.';
  }
}

/** Chuyển số tiền theo locale Việt Nam, tránh hiển thị số khó đọc trong card mobile. */
function formatAmount(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(amount)}₫`;
}

/** Bảng/card queue admin với pagination, filter và count đều lấy từ server. */
export default function TransferStatusPanel({ onPushToast }: TransferStatusPanelProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('ALL');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<DialogState>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeParams = useMemo(() => getTabParams(activeTab, page, PAGE_LIMIT), [activeTab, page]);
  const activeQuery = useManualReviewQueue(activeParams);
  const countsQuery = useManualReviewQueueCounts();
  const activeData = activeQuery.data;
  const items = activeData?.items ?? [];
  const totalPages = Math.max(1, activeData?.totalPages ?? 1);
  const totalPending = countsQuery.data?.all ?? 0;
  const tabTotals: Record<TabKey, number> = {
    ALL: countsQuery.data?.all ?? 0,
    EMERGENCY: countsQuery.data?.emergency ?? 0,
    NORMAL: countsQuery.data?.normal ?? 0,
    OVERDUE: countsQuery.data?.overdue ?? 0
  };

  /** Invalidate toàn bộ biến thể query để count và trang đang mở cùng cập nhật. */
  const refreshQueueNow = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ['manualReviewQueue'] });
  }, [queryClient]);

  /** Gom event/poll burst trong 3 giây để chỉ refresh list và aggregate counts một lần. */
  const scheduleQueueRefresh = useCallback(() => {
    if (queueRefreshTimerRef.current) clearTimeout(queueRefreshTimerRef.current);
    queueRefreshTimerRef.current = setTimeout(() => {
      queueRefreshTimerRef.current = null;
      void refreshQueueNow();
    }, QUEUE_REFRESH_DEBOUNCE_MS);
  }, [refreshQueueNow]);

  useEffect(() => () => {
    if (queueRefreshTimerRef.current) clearTimeout(queueRefreshTimerRef.current);
  }, []);

  /** Đổi tab luôn quay về trang đầu và để server thực hiện filter. */
  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    setPage(1);
  }, []);

  /** Surface realtime event, loại row resolved bằng invalidate thay vì optimistic đoán trạng thái. */
  const handleSocketEvent = useCallback((event: TransferSocketEvent) => {
    if (event.type === 'transfer:manual-review-required') {
      scheduleQueueRefresh();
      onPushToast?.({
        titleText: 'Transfer mới cần xử lý',
        bodyText: `RequestId: ${shortenIdentifier(event.requestId)}`,
        tone: 'warning'
      });
      return;
    }
    if (event.type === 'transfer:escalation-alert') {
      scheduleQueueRefresh();
      onPushToast?.({
        titleText: 'Manual review đã quá SLA',
        bodyText: `RequestId: ${shortenIdentifier(event.requestId)}`,
        tone: 'warning'
      });
      return;
    }
    scheduleQueueRefresh();
    if (event.payosTransferStatus && event.payosTransferStatus !== 'MANUAL_REVIEW') {
      onPushToast?.({
        titleText: 'Queue item đã thay đổi',
        bodyText: `RequestId: ${shortenIdentifier(event.requestId)} không còn ở manual review.`,
        tone: 'info'
      });
    }
  }, [onPushToast, scheduleQueueRefresh]);

  /** Polling/reconnect đều dùng cùng invalidation path để tránh tạo request sentinel giả. */
  const handlePollTick = useCallback(() => {
    scheduleQueueRefresh();
  }, [scheduleQueueRefresh]);

  const { isConnected, isUsingFallback } = useTransferSocket({
    onEvent: handleSocketEvent,
    onPollTick: handlePollTick,
    onReconnect: handlePollTick
  });

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const queueError = activeQuery.error
    ?? countsQuery.error;

  useEffect(() => {
    if (queueError?.kind === 'FORBIDDEN') router.push('/unauthorized');
  }, [queueError, router]);

  /** Xử lý thành công action: bỏ row sau response và invalidate để total server chính xác. */
  const handleDialogSuccess = useCallback((requestId: string, mode: 'approve' | 'reject') => {
    setDialog(null);
    void refreshQueueNow();
    onPushToast?.({
      titleText: mode === 'approve' ? 'Approve đã được chấp nhận' : 'Reject thành công',
      bodyText: mode === 'approve'
        ? `Disbursement ${shortenIdentifier(requestId)} đang PROCESSING và chờ webhook.`
        : `Disbursement ${shortenIdentifier(requestId)} đã được từ chối.`,
      tone: 'success'
    });
  }, [onPushToast, refreshQueueNow]);

  const errorMessage = queueError ? getQueueErrorMessage(queueError) : '';
  const isInitialLoading = activeQuery.isPending && !activeData;
  const isQueueEmpty = totalPending === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Transfer Status</h2>
          <p className="mt-0.5 text-xs text-slate-500">Manual Review cần xử lý: <span className="font-semibold text-slate-700">{totalPending}</span></p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isConnected ? 'bg-emerald-50 text-emerald-700' : isUsingFallback ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : isUsingFallback ? 'animate-pulse bg-amber-500' : 'bg-slate-400'}`} />
            {isConnected ? 'Real-time' : isUsingFallback ? 'Polling fallback' : 'Đang kết nối...'}
          </span>
          <button type="button" onClick={() => void refreshQueueNow()} className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white">
            Làm mới
          </button>
        </div>
      </div>

      {tabTotals.EMERGENCY > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3">
          <span className="mt-0.5 shrink-0 text-lg" aria-hidden="true">⚠</span>
          <div>
            <p className="text-sm font-bold text-red-800">Giao dịch khẩn cấp cần xử lý ngay!</p>
            <p className="mt-0.5 text-xs text-red-700">Có <span className="font-semibold">{tabTotals.EMERGENCY}</span> giao dịch EMERGENCY đang chờ manual review. Tier EMERGENCY cần escalation sau 24h.</p>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Bộ lọc manual review" className="flex gap-1 overflow-x-auto rounded-xl border border-emerald-900/15 bg-white p-1.5">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`shrink-0 rounded-lg px-4 py-1.5 text-xs font-semibold transition ${activeTab === tab.key ? 'bg-[#0E7C6B] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {tab.label}
            <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]" aria-live="polite">{tabTotals[tab.key]}</span>
          </button>
        ))}
      </div>

      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700" role="alert">
          {errorMessage}
          {queueError?.kind !== 'FORBIDDEN' && (
            <button
              type="button"
              onClick={() => void (activeQuery.error ? activeQuery.refetch() : refreshQueueNow())}
              className="ml-3 font-bold underline"
            >
              Thử lại
            </button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="hidden overflow-x-auto sm:block">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Request ID</th>
                <th className="px-4 py-2.5 font-semibold">Project / Mode</th>
                <th className="px-4 py-2.5 font-semibold">Số tiền</th>
                <th className="px-4 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-4 py-2.5 font-semibold">Retry / SLA</th>
                <th className="px-4 py-2.5 font-semibold">Cập nhật</th>
                <th className="px-4 py-2.5 text-right font-semibold">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {isInitialLoading ? (
                Array.from({ length: 4 }).map((_, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-slate-100" aria-busy="true">
                    {Array.from({ length: 7 }).map((__, columnIndex) => <td key={columnIndex} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-slate-200" /></td>)}
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-xs text-slate-400">{isQueueEmpty ? 'Queue đang rỗng.' : 'Tab này không có giao dịch phù hợp.'}</td></tr>
              ) : (
                items.map((item, index) => {
                  const badge = getStatusBadge(item.payosTransferStatus);
                  return (
                    <tr key={item.queueId} className={`border-t border-slate-100 ${item.requestMode === 'EMERGENCY' ? 'bg-red-50/40' : index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                      <td className="px-4 py-3"><Link href={`/admin/transfers/${encodeURIComponent(item.requestId)}`} className="font-mono text-xs font-semibold text-cyan-700 hover:underline">{shortenIdentifier(item.requestId)}</Link><p className="mt-0.5 font-mono text-[10px] text-slate-400">Q: {shortenIdentifier(item.queueId)}</p></td>
                      <td className="px-4 py-3"><p className="text-xs font-semibold text-slate-700">{shortenIdentifier(item.projectId)}</p>{item.requestMode === 'EMERGENCY' && <span className="mt-0.5 inline-flex rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">🚨 EMERGENCY</span>}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{formatAmount(item.amount)}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.label}</span></td>
                      <td className="px-4 py-3"><span className="mr-2 text-xs text-slate-500">×{item.payosTransferAttemptCount}</span><CountdownTimer deadline={item.slaDeadline} escalatedAt={item.escalatedAt} /></td>
                      <td className="px-4 py-3 text-xs text-slate-500">{new Date(item.updatedAt).toLocaleString('vi-VN')}</td>
                      <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1.5">{item.payosTransferStatus === 'MANUAL_REVIEW' && <><button type="button" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setDialog({ item, mode: 'approve' }); }} aria-label={`Approve ${item.requestId}`} className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 transition hover:bg-emerald-600 hover:text-white">Approve</button><button type="button" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setDialog({ item, mode: 'reject' }); }} aria-label={`Reject ${item.requestId}`} className="rounded-lg border border-red-200 px-2.5 py-1.5 text-[11px] font-bold text-red-600 transition hover:bg-red-600 hover:text-white">Reject</button></>}</div></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-100 sm:hidden">
          {isInitialLoading ? Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-36 animate-pulse bg-slate-100" aria-busy="true" />) : items.length === 0 ? <p className="px-5 py-14 text-center text-xs text-slate-400">{isQueueEmpty ? 'Queue đang rỗng.' : 'Tab này không có giao dịch phù hợp.'}</p> : items.map((item) => {
            const badge = getStatusBadge(item.payosTransferStatus);
            return <article key={item.queueId} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><Link href={`/admin/transfers/${encodeURIComponent(item.requestId)}`} className="font-mono text-xs font-semibold text-cyan-700">{shortenIdentifier(item.requestId)}</Link><p className="mt-1 text-[11px] text-slate-500">{item.requestMode === 'EMERGENCY' ? '🚨 EMERGENCY' : 'NORMAL'} · {formatAmount(item.amount)}</p></div><span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.label}</span></div><div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>×{item.payosTransferAttemptCount}</span><CountdownTimer deadline={item.slaDeadline} escalatedAt={item.escalatedAt} /></div>{item.payosTransferStatus === 'MANUAL_REVIEW' && <div className="flex gap-2"><button type="button" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setDialog({ item, mode: 'approve' }); }} className="flex-1 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700">Approve</button><button type="button" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setDialog({ item, mode: 'reject' }); }} className="flex-1 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600">Reject</button></div>}</article>;
          })}
        </div>

        {!isInitialLoading && items.length > 0 && totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
            <p className="text-xs text-slate-500">Trang {page}/{totalPages} · {activeData?.total ?? 0} items</p>
            <div className="flex gap-1"><button type="button" disabled={page <= 1} onClick={() => setPage((currentPage) => currentPage - 1)} className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">← Trước</button><button type="button" disabled={page >= totalPages} onClick={() => setPage((currentPage) => currentPage + 1)} className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">Sau →</button></div>
          </div>
        )}
      </div>

      {dialog && <ManualReviewDialog requestId={dialog.item.requestId} projectId={dialog.item.projectId} amount={dialog.item.amount} mode={dialog.mode} onClose={() => setDialog(null)} onSuccess={handleDialogSuccess} onError={(message) => onPushToast?.({ titleText: 'Lỗi manual review', bodyText: message, tone: 'error' })} onRefresh={() => void refreshQueueNow()} returnFocusRef={dialogTriggerRef} />}
    </div>
  );
}
