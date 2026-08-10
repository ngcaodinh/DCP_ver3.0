'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useRetrySbtMintJob, useSbtDlqList } from '@/app/hooks/useSbtDlqList';
import {
  isDlqEntryEscalated,
  SBT_DLQ_RETRY_WATCH_TIMEOUT_MS,
  SBT_DLQ_STATUS_TABS
} from '@/app/constants/sbtDlq';
import type { ToastItem } from '@/app/components/systemAdmin/tailwind/types';
import type { SbtDlqError, SbtDlqStatus, SbtMintDlqEntry } from '@/app/types/sbtRetry';
import DlqDetailModal from './DlqDetailModal';

interface DLQManagementProps {
  onPushToast?: (toast: Omit<ToastItem, 'id'>) => void;
}

type DlqModalState = {
  entry: SbtMintDlqEntry;
  phase: 'detail' | 'confirm';
} | null;

type ToastTone = ToastItem['tone'];

/** Định dạng timestamp DLQ theo locale Việt Nam và giữ nguyên fallback nếu dữ liệu lỗi. */
function formatDlqDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('vi-VN');
}

/** Rút gọn lý do lỗi ở bảng nhưng vẫn giữ toàn bộ nội dung trong modal chi tiết. */
function truncateDlqError(message: string): string {
  return message.length > 100 ? `${message.slice(0, 100)}…` : message;
}

/** Trả badge trạng thái DLQ theo dữ liệu server để bảng không tự suy đoán lifecycle. */
function getDlqStatusBadge(status: SbtDlqStatus): { label: string; className: string } {
  switch (status) {
    case 'RECOVERED':
      return { label: 'Đã khôi phục', className: 'border-emerald-200 bg-emerald-100 text-emerald-800' };
    case 'ABANDONED':
      return { label: 'Đã bỏ qua', className: 'border-slate-200 bg-slate-100 text-slate-600' };
    default:
      return { label: 'Đang mở', className: 'border-amber-200 bg-amber-100 text-amber-800' };
  }
}

/** Gửi toast thống nhất cho các nhánh retry và polling của DLQ. */
function pushRetryToast(
  onPushToast: DLQManagementProps['onPushToast'],
  titleText: string,
  bodyText: string,
  tone: ToastTone
): void {
  onPushToast?.({ titleText, bodyText, tone });
}

/** Bảng quản lý DLQ SBT với retry qua worker, modal chi tiết và polling có kiểm soát. */
export default function DLQManagement({ onPushToast }: DLQManagementProps): ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<SbtDlqStatus>('OPEN');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<DlqModalState>(null);
  const [inFlightRevision, setInFlightRevision] = useState(0);
  const inFlightMapRef = useRef<Map<string, number>>(new Map());
  const modalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inFlightMap = inFlightMapRef.current;
  const isPollingEnabled = inFlightMap.size > 0;
  const listQuery = useSbtDlqList({ page, status, isPollingEnabled });
  const retryMutation = useRetrySbtMintJob();
  const entries = listQuery.data?.entries ?? [];
  const now = new Date();
  const refetchDlqList = listQuery.refetch;

  /** Cập nhật tracking retry tại một nguồn dữ liệu và tăng revision để React render lại UI. */
  const replaceInFlightMap = useCallback((nextMap: Map<string, number>): void => {
    inFlightMapRef.current = nextMap;
    setInFlightRevision((revision) => revision + 1);
  }, []);

  /** Xóa tracking retry khi admin chuyển context để không suy diễn dòng biến mất là success. */
  const clearInFlightTracking = useCallback((): void => {
    replaceInFlightMap(new Map());
  }, [replaceInFlightMap]);

  /** Chuyển tab server-side và reset về trang đầu theo contract pagination của BE. */
  const handleStatusChange = useCallback((nextStatus: SbtDlqStatus): void => {
    clearInFlightTracking();
    setStatus(nextStatus);
    setPage(1);
  }, [clearInFlightTracking]);

  /** Chuyển trang server-side và bỏ các job đang theo dõi ở context cũ. */
  const handlePageChange = useCallback((nextPage: number): void => {
    clearInFlightTracking();
    setPage(nextPage);
  }, [clearInFlightTracking]);

  useEffect(() => {
    if (listQuery.error?.kind === 'FORBIDDEN') {
      router.push('/unauthorized');
    } else if (listQuery.error?.kind === 'UNAUTHENTICATED') {
      router.push('/login');
    }
  }, [listQuery.error, router]);

  useEffect(() => {
    const currentInFlightMap = inFlightMapRef.current;
    if (!listQuery.data || listQuery.isFetching || listQuery.isPlaceholderData || currentInFlightMap.size === 0) return;

    const currentEntryIds = new Set(listQuery.data.entries.map((entry) => entry.mintRequestId));
    const completedIds = Array.from(currentInFlightMap.keys()).filter((mintRequestId) => !currentEntryIds.has(mintRequestId));
    if (completedIds.length === 0) return;

    completedIds.forEach((mintRequestId) => {
      pushRetryToast(onPushToast, 'SBT mint thành công', `Job ${mintRequestId} đã rời khỏi DLQ sau khi worker xử lý.`, 'success');
    });
    const nextMap = new Map(inFlightMapRef.current);
    completedIds.forEach((mintRequestId) => nextMap.delete(mintRequestId));
    replaceInFlightMap(nextMap);
  }, [inFlightRevision, listQuery.data, listQuery.isFetching, listQuery.isPlaceholderData, onPushToast, replaceInFlightMap]);

  useEffect(() => {
    const timers = Array.from(inFlightMapRef.current.entries()).map(([mintRequestId, startedAtMs]) => {
      const remainingMs = Math.max(0, SBT_DLQ_RETRY_WATCH_TIMEOUT_MS - (Date.now() - startedAtMs));
      return window.setTimeout(() => {
        const currentMap = inFlightMapRef.current;
        if (!currentMap.has(mintRequestId)) return;
        const nextMap = new Map(currentMap);
        nextMap.delete(mintRequestId);
        replaceInFlightMap(nextMap);
        pushRetryToast(onPushToast, 'Worker vẫn đang chờ', `Job ${mintRequestId} chưa rời DLQ sau 3 phút; đã tắt theo dõi tự động.`, 'info');
      }, remainingMs);
    });

    return () => timers.forEach((timerId) => window.clearTimeout(timerId));
  }, [inFlightRevision, onPushToast, replaceInFlightMap]);

  /** Mở modal detail hoặc confirm và ghi nhớ nút để trả focus sau khi đóng. */
  const openModal = useCallback((entry: SbtMintDlqEntry, phase: 'detail' | 'confirm', trigger: HTMLButtonElement): void => {
    modalTriggerRef.current = trigger;
    setModal({ entry, phase });
  }, []);

  /** Đóng modal và để component modal trả focus về trigger gần nhất. */
  const closeModal = useCallback((): void => {
    if (retryMutation.isPending) return;
    setModal(null);
  }, [retryMutation.isPending]);

  /** Xử lý response retry, phân biệt job đã enqueue với response 200 nhưng queue chưa nhận job. */
  const handleRetrySuccess = useCallback((entry: SbtMintDlqEntry, result: { enqueued: boolean }): void => {
    setModal(null);
    if (result.enqueued) {
      const nextMap = new Map(inFlightMapRef.current);
      nextMap.set(entry.mintRequestId, Date.now());
      replaceInFlightMap(nextMap);
      pushRetryToast(onPushToast, 'Đã đưa vào hàng đợi', `Job ${entry.mintRequestId} đang được worker chạy lại.`, 'info');
      return;
    }

    pushRetryToast(
      onPushToast,
      'Chưa enqueue được job',
      'Đã reset nhưng chưa đẩy được vào hàng đợi — cron 15 phút sẽ tự nhặt.',
      'warning'
    );
  }, [onPushToast, replaceInFlightMap]);

  /** Xử lý lỗi retry tại nơi có đủ ngữ cảnh UI để refetch, redirect và hiển thị message BE. */
  const handleRetryError = useCallback((error: SbtDlqError): void => {
    if (error.kind === 'UNAUTHENTICATED' || error.statusCode === 401) {
      router.push('/login');
      return;
    }

    if (error.kind === 'FORBIDDEN' || error.statusCode === 403) {
      router.push('/unauthorized');
      return;
    }

    if (error.kind === 'CONFLICT' || error.statusCode === 409) {
      pushRetryToast(onPushToast, 'Job đã thay đổi', error.message, 'error');
      void refetchDlqList();
      return;
    }

    const message = error.kind === 'RATE_LIMITED' && !error.message.toLowerCase().includes('ip')
      ? `${error.message} Hạn mức dùng chung theo IP.`
      : error.message;
    pushRetryToast(onPushToast, 'Retry job thất bại', message, 'error');
  }, [onPushToast, refetchDlqList, router]);

  /** Xác nhận retry job qua mutation hook và không gọi API khi chỉ mở modal. */
  const handleConfirmRetry = useCallback((): void => {
    if (!modal) return;
    retryMutation.mutate(modal.entry.mintRequestId, {
      onSuccess: (result) => handleRetrySuccess(modal.entry, result),
      onError: handleRetryError
    });
  }, [handleRetryError, handleRetrySuccess, modal, retryMutation]);

  useEffect(() => {
    const totalPages = Math.max(1, listQuery.data?.pagination.totalPages ?? 1);
    if (page > totalPages) handlePageChange(totalPages);
  }, [handlePageChange, listQuery.data?.pagination.totalPages, page]);

  const isInitialLoading = listQuery.isPending && !listQuery.data;
  const totalPages = Math.max(1, listQuery.data?.pagination.totalPages ?? 1);
  const isEmpty = !isInitialLoading && entries.length === 0;
  const statusEmptyMessage = status === 'ABANDONED'
    ? 'Chưa có job nào bị đánh dấu bỏ qua.'
    : 'Không có job nào trong tab này.';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">SBT Mint Retry</h2>
          <p className="mt-0.5 text-xs text-slate-500">Job đang mở: <span className="font-semibold text-slate-700">{listQuery.data?.openCount ?? 0}</span></p>
          <p className="mt-2 max-w-2xl text-xs text-slate-500">Hệ thống không hỗ trợ mint thủ công. Job hỏng chỉ có thể chạy lại qua worker.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isPollingEnabled ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isPollingEnabled ? 'animate-pulse bg-amber-500' : 'bg-slate-400'}`} />
            {isPollingEnabled ? 'Polling 10 giây' : 'Polling tắt'}
          </span>
          <button type="button" onClick={() => void listQuery.refetch()} className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white">
            Làm mới
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="Trạng thái SBT mint DLQ" className="flex gap-1 overflow-x-auto rounded-xl border border-emerald-900/15 bg-white p-1.5">
        {SBT_DLQ_STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={status === tab.key}
            onClick={() => handleStatusChange(tab.key)}
            className={`shrink-0 rounded-lg px-4 py-1.5 text-xs font-semibold transition ${status === tab.key ? 'bg-[#0E7C6B] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {tab.label}
            {tab.key === 'OPEN' && <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]">{listQuery.data?.openCount ?? 0}</span>}
          </button>
        ))}
      </div>

      <p className="text-right text-[11px] text-slate-400">Sắp xếp: cũ nhất trước</p>

      {listQuery.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700" role="alert">
          {listQuery.error.message}
          {listQuery.error.kind !== 'FORBIDDEN' && (
            <button type="button" onClick={() => void listQuery.refetch()} className="ml-3 font-bold underline">Thử lại</button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="hidden overflow-x-auto sm:block">
          <table className="min-w-[760px] text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Dự án</th>
                <th className="px-4 py-2.5 font-semibold">Thời điểm hỏng</th>
                <th className="px-4 py-2.5 font-semibold">Lý do hỏng</th>
                <th className="px-4 py-2.5 font-semibold">Số lần</th>
                <th className="px-4 py-2.5 text-right font-semibold">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {isInitialLoading ? (
                Array.from({ length: 4 }).map((_, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-slate-100" aria-busy="true">
                    {Array.from({ length: 5 }).map((__, columnIndex) => <td key={columnIndex} className="px-4 py-4"><div className="h-4 animate-pulse rounded bg-slate-200" /></td>)}
                  </tr>
                ))
              ) : isEmpty ? (
                <tr><td colSpan={5} className="px-4 py-16 text-center text-xs text-slate-400">{statusEmptyMessage}</td></tr>
              ) : (
                entries.map((entry) => {
                  const escalated = isDlqEntryEscalated(entry, now);
                  const badge = getDlqStatusBadge(entry.status);
                  const isInFlight = inFlightMap.has(entry.mintRequestId);
                  return (
                    <tr key={entry.dlqId} data-testid="sbt-dlq-row" className={`border-t border-slate-100 ${escalated ? 'bg-red-50/40' : 'bg-white'}`}>
                      <td className="max-w-[220px] px-4 py-3">
                        <button type="button" onClick={(event) => openModal(entry, 'detail', event.currentTarget)} className="block max-w-full text-left" title={entry.projectId}>
                          <span className="block truncate font-mono text-xs font-semibold text-slate-700">{entry.projectName ?? entry.projectId}</span>
                          <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400">{entry.projectId}</span>
                        </button>
                        {escalated && <span className="mt-1 inline-flex rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">Cảnh báo</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDlqDateTime(entry.dlqAt)}</td>
                      <td className="max-w-[320px] px-4 py-3 text-xs text-slate-600" title={entry.lastErrorMessage}>{truncateDlqError(entry.lastErrorMessage)}</td>
                      <td className="px-4 py-3"><span className="font-semibold text-slate-700">×{entry.attemptNumber}</span><span className={`ml-2 inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>{isInFlight ? 'Đang chạy lại' : badge.label}</span></td>
                      <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1.5"><button type="button" onClick={(event) => openModal(entry, 'detail', event.currentTarget)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">Chi tiết</button>{entry.status === 'OPEN' && <button type="button" disabled={isInFlight} onClick={(event) => openModal(entry, 'confirm', event.currentTarget)} className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">{isInFlight ? 'Đang chạy lại' : 'Chạy lại'}</button>}</div></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 p-3 sm:hidden">
          {isInitialLoading ? (
            Array.from({ length: 4 }).map((_, cardIndex) => <div key={cardIndex} className="h-28 animate-pulse rounded-lg bg-slate-100" />)
          ) : isEmpty ? (
            <p className="px-3 py-12 text-center text-xs text-slate-400">{statusEmptyMessage}</p>
          ) : (
            entries.map((entry) => {
              const escalated = isDlqEntryEscalated(entry, now);
              const isInFlight = inFlightMap.has(entry.mintRequestId);
              return (
                <article key={entry.dlqId} data-testid="sbt-dlq-card" className={`min-w-0 rounded-lg border border-slate-100 p-3 ${escalated ? 'bg-red-50/40' : 'bg-white'}`}>
                  <div className="flex items-start justify-between gap-3"><button type="button" onClick={(event) => openModal(entry, 'detail', event.currentTarget)} className="min-w-0 text-left"><span className="block truncate font-mono text-xs font-semibold text-slate-700">{entry.projectName ?? entry.projectId}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400">{entry.projectId}</span></button>{escalated && <span className="shrink-0 rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">Cảnh báo</span>}</div>
                  <p className="mt-2 text-[11px] text-slate-500">{formatDlqDateTime(entry.dlqAt)} · ×{entry.attemptNumber}</p>
                  <p className="mt-2 break-words text-xs text-slate-600">{truncateDlqError(entry.lastErrorMessage)}</p>
                  <div className="mt-3 flex gap-2"><button type="button" onClick={(event) => openModal(entry, 'detail', event.currentTarget)} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">Chi tiết</button>{entry.status === 'OPEN' && <button type="button" disabled={isInFlight} onClick={(event) => openModal(entry, 'confirm', event.currentTarget)} className="flex-1 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700 disabled:opacity-50">{isInFlight ? 'Đang chạy lại' : 'Chạy lại'}</button>}</div>
                </article>
              );
            })
          )}
        </div>

        {!isInitialLoading && entries.length > 0 && totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
            <p className="text-xs text-slate-500">Trang {page}/{totalPages} · {listQuery.data?.pagination.total ?? 0} job</p>
            <div className="flex gap-1"><button type="button" disabled={page <= 1} onClick={() => handlePageChange(page - 1)} className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">← Trước</button><button type="button" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)} className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">Sau →</button></div>
          </div>
        )}
      </div>

      {modal && (
        <DlqDetailModal
          key={modal.entry.mintRequestId}
          entry={modal.entry}
          initialPhase={modal.phase}
          isSubmitting={retryMutation.isPending}
          onClose={closeModal}
          onConfirm={handleConfirmRetry}
          returnFocusRef={modalTriggerRef}
        />
      )}
    </div>
  );
}
