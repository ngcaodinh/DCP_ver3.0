'use client';

// =============================================================================
// TransferQueuePanel — A4: Admin Transfer Queue
// Mục đích: Hiển thị và xử lý hàng chờ chuyển khoản thủ công (MANUAL_REVIEW)
//           cho admin. Cho phép assign và resolve từng item.
// =============================================================================

import { useState, useCallback, useEffect } from 'react';
import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type { ToastItem } from './types';

// ============ TYPES ============

type ManualReviewStatus = 'PENDING' | 'ASSIGNED' | 'RESOLVED';
type ResolveAction = 'RETRY' | 'CANCEL' | 'MANUAL_TRANSFER';

type QueueItem = {
  queueId: string;
  requestId: string;
  reason: string;
  attemptCountAtEnqueue: number;
  status: ManualReviewStatus;
  assignedAdminId: string | null;
  assignedAt: string | null;
  resolvedByAdminId: string | null;
  resolveAction: ResolveAction | null;
  resolveNote: string | null;
  resolvedAt: string | null;
  enqueuedAt: string;
  updatedAt: string;
};

type QueueListResponse = {
  items: QueueItem[];
  total: number;
  page: number;
  limit: number;
};

type StatusFilter = 'ALL' | ManualReviewStatus;

// ============ HELPERS ============

function formatDateTime(isoString: string | null): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('vi-VN');
}

function getStatusBadge(status: ManualReviewStatus): { label: string; className: string } {
  switch (status) {
    case 'PENDING':
      return { label: 'Chờ xử lý', className: 'bg-amber-100 text-amber-800 border-amber-200' };
    case 'ASSIGNED':
      return { label: 'Đang xử lý', className: 'bg-blue-100 text-blue-800 border-blue-200' };
    case 'RESOLVED':
      return { label: 'Đã xử lý', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
  }
}

function getResolveActionLabel(action: ResolveAction | null): string {
  switch (action) {
    case 'RETRY': return 'Retry tự động';
    case 'CANCEL': return 'Hủy giải ngân';
    case 'MANUAL_TRANSFER': return 'Đã chuyển tay';
    default: return '—';
  }
}

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'PENDING', label: 'Chờ xử lý' },
  { value: 'ASSIGNED', label: 'Đang xử lý' },
  { value: 'RESOLVED', label: 'Đã xử lý' },
];

const RESOLVE_ACTION_OPTIONS: { value: ResolveAction; label: string; description: string }[] = [
  { value: 'RETRY', label: 'Retry tự động', description: 'Reset và để worker retry từ đầu' },
  { value: 'CANCEL', label: 'Hủy giải ngân', description: 'Hủy yêu cầu, không chuyển khoản' },
  { value: 'MANUAL_TRANSFER', label: 'Đã chuyển tay', description: 'Đã chuyển khoản thủ công ngoài hệ thống' },
];

// ============ RESOLVE MODAL ============

type ResolveModalProps = {
  item: QueueItem;
  onClose: () => void;
  onSuccess: (updated: QueueItem) => void;
  onPushToast?: (t: Omit<ToastItem, 'id'>) => void;
};

function ResolveModal({ item, onClose, onSuccess, onPushToast }: ResolveModalProps) {
  const [resolveAction, setResolveAction] = useState<ResolveAction>('RETRY');
  const [resolveNote, setResolveNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = useCallback(async () => {
    if (resolveNote.trim().length < 5) {
      setErrorMessage('Ghi chú phải tối thiểu 5 ký tự.');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const session = readAuthSession();
      const response = await fetchApi<QueueItem>(
        buildApiUrl(`/api/admin/transfer-queue/${item.queueId}/resolve`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ resolveAction, resolveNote: resolveNote.trim() }),
        }
      );
      onSuccess(response.data);
      onPushToast?.({ titleText: 'Resolve thành công', bodyText: `Hành động: ${getResolveActionLabel(resolveAction)}`, tone: 'success' });
      onClose();
    } catch (err) {
      setErrorMessage((err as Error)?.message || 'Resolve thất bại. Vui lòng thử lại.');
    } finally {
      setIsSubmitting(false);
    }
  }, [item.queueId, resolveAction, resolveNote, onClose, onSuccess, onPushToast]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">Resolve yêu cầu thủ công</h3>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{item.requestId}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Reason */}
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800">Lý do vào hàng chờ:</p>
          <p className="mt-1 text-xs text-amber-700">{item.reason}</p>
          <p className="mt-1 text-[11px] text-amber-600">Số lần đã retry: {item.attemptCountAtEnqueue}</p>
        </div>

        {/* Action selector */}
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold text-slate-700">Hành động xử lý:</p>
          {RESOLVE_ACTION_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${resolveAction === opt.value ? 'border-[#0E7C6B] bg-emerald-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
            >
              <input
                type="radio"
                name="resolveAction"
                value={opt.value}
                checked={resolveAction === opt.value}
                onChange={() => setResolveAction(opt.value)}
                className="mt-0.5 accent-[#0E7C6B]"
              />
              <div>
                <p className="text-xs font-semibold text-slate-800">{opt.label}</p>
                <p className="text-[11px] text-slate-500">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>

        {/* Note */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-slate-700">
            Ghi chú <span className="text-red-500">*</span>
          </label>
          <textarea
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            rows={3}
            placeholder="Nhập ghi chú xử lý (tối thiểu 5 ký tự)..."
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-[#0E7C6B] focus:ring-1 focus:ring-[#0E7C6B]/30"
          />
        </div>

        {errorMessage && (
          <p className="mt-2 text-xs text-red-600">{errorMessage}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || resolveNote.trim().length < 5}
            className="rounded-lg bg-[#0E7C6B] px-4 py-2 text-xs font-bold text-white hover:bg-[#0a6559] disabled:opacity-50"
          >
            {isSubmitting ? 'Đang xử lý...' : 'Xác nhận'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ MAIN PANEL ============

type TransferQueuePanelProps = {
  onPushToast?: (t: Omit<ToastItem, 'id'>) => void;
};

export default function TransferQueuePanel({ onPushToast }: TransferQueuePanelProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [resolvingItem, setResolvingItem] = useState<QueueItem | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const limit = 20;

  const loadQueue = useCallback(async (currentPage: number, filter: StatusFilter) => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const session = readAuthSession();
      const url = buildApiUrl(
        `/api/admin/transfer-queue?status=${filter}&page=${currentPage}&limit=${limit}`
      );
      const response = await fetchApi<QueueListResponse>(url, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      setItems(response.data.items ?? []);
      setTotal(response.data.total ?? 0);
    } catch {
      setErrorMessage('Không thể tải hàng chờ chuyển khoản.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue(page, statusFilter);
  }, [loadQueue, page, statusFilter]);

  const handleFilterChange = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    setPage(1);
  }, []);

  const handleAssign = useCallback(async (queueId: string) => {
    setAssigningId(queueId);
    try {
      const session = readAuthSession();
      const response = await fetchApi<QueueItem>(
        buildApiUrl(`/api/admin/transfer-queue/${queueId}/assign`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.accessToken}` },
        }
      );
      setItems((prev) => prev.map((item) => item.queueId === queueId ? response.data : item));
      onPushToast?.({ titleText: 'Đã nhận xử lý', bodyText: `Queue item ${queueId.slice(0, 8)}...`, tone: 'success' });
    } catch {
      onPushToast?.({ titleText: 'Lỗi', bodyText: 'Không thể assign item. Vui lòng thử lại.', tone: 'error' });
    } finally {
      setAssigningId(null);
    }
  }, [onPushToast]);

  const handleResolveSuccess = useCallback((updated: QueueItem) => {
    setItems((prev) => prev.map((item) => item.queueId === updated.queueId ? updated : item));
  }, []);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Hàng chờ chuyển khoản thủ công</h2>
          <p className="mt-1 text-xs text-slate-500">
            Các yêu cầu giải ngân đã hết retry tự động, cần admin xử lý thủ công.
            Tổng: <span className="font-semibold text-slate-700">{total}</span> items.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadQueue(page, statusFilter)}
          className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
        >
          Làm mới
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 rounded-xl border border-emerald-900/15 bg-white p-1.5">
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleFilterChange(opt.value)}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
              statusFilter === opt.value
                ? 'bg-[#0E7C6B] text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {errorMessage}
          <button
            type="button"
            onClick={() => loadQueue(page, statusFilter)}
            className="ml-3 font-bold underline"
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Request ID</th>
                <th className="px-4 py-2.5 font-semibold">Lý do</th>
                <th className="px-4 py-2.5 font-semibold">Retry</th>
                <th className="px-4 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-4 py-2.5 font-semibold">Vào hàng lúc</th>
                <th className="px-4 py-2.5 font-semibold text-right">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    {Array.from({ length: 6 }).map((__, col) => (
                      <td key={col} className="px-4 py-3">
                        <div className="h-4 animate-pulse rounded bg-slate-200" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-xs text-slate-500">
                    Không có item nào trong hàng chờ.
                  </td>
                </tr>
              ) : (
                items.map((item, i) => {
                  const badge = getStatusBadge(item.status);
                  return (
                    <tr
                      key={item.queueId}
                      className={`border-t border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-cyan-700">
                          {item.requestId.slice(0, 16)}...
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                          Q: {item.queueId.slice(0, 8)}...
                        </p>
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        <p className="line-clamp-2 text-xs text-slate-600">{item.reason}</p>
                        {item.resolveAction && (
                          <p className="mt-0.5 text-[10px] font-semibold text-emerald-700">
                            → {getResolveActionLabel(item.resolveAction)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center font-mono text-xs font-semibold text-slate-700">
                        {item.attemptCountAtEnqueue}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {formatDateTime(item.enqueuedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {item.status === 'PENDING' && (
                            <button
                              type="button"
                              disabled={assigningId === item.queueId}
                              onClick={() => handleAssign(item.queueId)}
                              className="rounded-lg border border-blue-200 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-600 hover:text-white disabled:opacity-50"
                            >
                              {assigningId === item.queueId ? '...' : 'Nhận'}
                            </button>
                          )}
                          {item.status !== 'RESOLVED' && (
                            <button
                              type="button"
                              onClick={() => setResolvingItem(item)}
                              className="rounded-lg border border-emerald-900/15 px-2.5 py-1.5 text-[11px] font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
                            >
                              Xử lý
                            </button>
                          )}
                          {item.status === 'RESOLVED' && (
                            <span className="text-[11px] text-slate-400">
                              {formatDateTime(item.resolvedAt)}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
            <p className="text-xs text-slate-500">
              Trang {page}/{totalPages} · {total} items
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resolve Modal */}
      {resolvingItem && (
        <ResolveModal
          item={resolvingItem}
          onClose={() => setResolvingItem(null)}
          onSuccess={handleResolveSuccess}
          onPushToast={onPushToast}
        />
      )}
    </div>
  );
}
