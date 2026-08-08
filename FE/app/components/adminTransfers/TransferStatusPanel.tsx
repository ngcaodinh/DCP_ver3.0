'use client';

// =============================================================================
// TransferStatusPanel — A4: bảng danh sách disbursement transfer cho admin
// Tabs: Tất cả / Đang chờ / Thất bại / Manual Review
// Real-time: Socket.io auto-refresh row + EMERGENCY warning banner
// =============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { useTransferSocket, type TransferSocketEvent } from '@/app/hooks/useTransferSocket';
import CountdownTimer from './CountdownTimer';
import ManualReviewDialog from './ManualReviewDialog';

// ============ TYPES ============

type TransferStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'MANUAL_REVIEW';

type TransferItem = {
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  payosTransferStatus: TransferStatus | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  updatedAt: string;
  createdAt: string;
  nextRetryAt: null;
};

// Endpoint pending-review chỉ trả MANUAL_REVIEW items — tab chỉ lọc theo mode
type TabKey = 'ALL' | 'EMERGENCY' | 'NORMAL';

type DialogState = { requestId: string; projectId: string; amount: number; mode: 'approve' | 'reject' } | null;

// ============ HELPERS ============

const TAB_OPTIONS: { key: TabKey; label: string }[] = [
  { key: 'ALL', label: 'Tất cả' },
  { key: 'EMERGENCY', label: 'Khẩn cấp' },
  { key: 'NORMAL', label: 'Thường' }
];

function getStatusBadge(status: TransferStatus | null) {
  switch (status) {
    case 'PROCESSING': return { label: 'Đang chờ', cls: 'bg-blue-100 text-blue-800 border-blue-200' };
    case 'SUCCESS':    return { label: 'Thành công', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    case 'FAILED':     return { label: 'Thất bại', cls: 'bg-red-100 text-red-800 border-red-200' };
    case 'MANUAL_REVIEW': return { label: 'Manual Review', cls: 'bg-amber-100 text-amber-800 border-amber-200' };
    default:           return { label: '—', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
  }
}

// ============ COMPONENT ============

type TransferStatusPanelProps = {
  onPushToast?: (t: { titleText: string; bodyText: string; tone: 'success' | 'error' | 'warning' | 'info' }) => void;
};

export default function TransferStatusPanel({ onPushToast }: TransferStatusPanelProps) {
  const [items, setItems] = useState<TransferItem[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('ALL');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const isLoadingRef = useRef(false);

  const loadItems = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setIsLoading(true);
    setErrorMsg('');
    try {
      const session = readAuthSession();
      const response = await fetchApi<{ items: TransferItem[]; total: number }>(
        buildApiUrl('/api/disbursements/pending-review'),
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      setItems(response.data.items ?? []);
      setTotalPending(response.data.total ?? response.data.items?.length ?? 0);
    } catch {
      setErrorMsg('Không thể tải danh sách transfer.');
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
    }
  }, []);

  useEffect(() => { void loadItems(); }, [loadItems]);

  // Socket.io: auto-refresh row khi có event, không reload toàn bộ
  const handleSocketEvent = useCallback((event: TransferSocketEvent) => {
    if (event.type === 'transfer:manual-review-required') {
      // Item mới vào queue → reload list
      void loadItems();
      onPushToast?.({ titleText: 'Transfer mới cần xử lý', bodyText: `RequestId: ${event.requestId.slice(0, 12)}...`, tone: 'warning' });
    } else if (event.type === 'transfer:updated') {
      if (event.requestId === '__poll__') {
        // Polling fallback signal → reload
        void loadItems();
      } else {
        // Cập nhật status của row cụ thể mà không reload toàn bộ
        setItems(prev =>
          prev.map(item =>
            item.requestId === event.requestId
              ? { ...item, payosTransferStatus: (event.payosTransferStatus as TransferStatus | null) ?? item.payosTransferStatus, updatedAt: event.updatedAt }
              : item
          )
        );
      }
    }
  }, [loadItems, onPushToast]);

  const { isConnected, isUsingFallback } = useTransferSocket({
    onEvent: handleSocketEvent,
    onConnectionChange: setIsSocketConnected
  });

  const handleDialogSuccess = useCallback((requestId: string, mode: 'approve' | 'reject') => {
    setItems(prev => prev.filter(item => item.requestId !== requestId));
    setTotalPending(prev => Math.max(0, prev - 1));
    onPushToast?.({
      titleText: mode === 'approve' ? 'Approve thành công' : 'Reject thành công',
      bodyText: `Disbursement ${requestId.slice(0, 12)}... đã được xử lý.`,
      tone: 'success'
    });
  }, [onPushToast]);

  // Filter theo tab — lọc theo requestMode vì data chỉ có MANUAL_REVIEW items
  const filtered = activeTab === 'ALL'
    ? items
    : items.filter(i => i.requestMode === activeTab);

  // EMERGENCY items nổi lên đầu
  const sorted = [...filtered].sort((a, b) => {
    if (a.requestMode === 'EMERGENCY' && b.requestMode !== 'EMERGENCY') return -1;
    if (b.requestMode === 'EMERGENCY' && a.requestMode !== 'EMERGENCY') return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const emergencyPendingCount = items.filter(i => i.requestMode === 'EMERGENCY' && i.payosTransferStatus === 'MANUAL_REVIEW').length;

  return (
    <div className="space-y-4">
      {/* Header + connection badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Transfer Status</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Manual Review cần xử lý: <span className="font-semibold text-slate-700">{totalPending}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isConnected ? 'bg-emerald-50 text-emerald-700' : isUsingFallback ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : isUsingFallback ? 'bg-amber-500 animate-pulse' : 'bg-slate-400'}`} />
            {isConnected ? 'Real-time' : isUsingFallback ? 'Polling fallback' : 'Đang kết nối...'}
          </span>
          <button type="button" onClick={() => void loadItems()} className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] hover:bg-[#0E7C6B] hover:text-white transition">
            Làm mới
          </button>
        </div>
      </div>

      {/* EMERGENCY warning banner */}
      {emergencyPendingCount > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3">
          <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="mt-0.5 shrink-0 text-red-600">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div>
            <p className="text-sm font-bold text-red-800">
              ⚠ Giao dịch khẩn cấp cần xử lý ngay!
            </p>
            <p className="mt-0.5 text-xs text-red-700">
              Có <span className="font-semibold">{emergencyPendingCount}</span> giao dịch EMERGENCY đang chờ manual review.
              Tier EMERGENCY cần escalation sau 24h.
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl border border-emerald-900/15 bg-white p-1.5">
        {TAB_OPTIONS.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${activeTab === tab.key ? 'bg-[#0E7C6B] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {tab.label}
            {tab.key !== 'ALL' && (
              <span className="ml-1.5 rounded-full bg-white/20 px-1.5 py-0.5 text-[10px]">
                {items.filter(i => i.requestMode === tab.key).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {errorMsg}
          <button type="button" onClick={() => void loadItems()} className="ml-3 font-bold underline">Thử lại</button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Request ID</th>
                <th className="px-4 py-2.5 font-semibold">Project / Mode</th>
                <th className="px-4 py-2.5 font-semibold">Số tiền</th>
                <th className="px-4 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-4 py-2.5 font-semibold">Retry / Timer</th>
                <th className="px-4 py-2.5 font-semibold">Cập nhật</th>
                <th className="px-4 py-2.5 font-semibold text-right">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {Array.from({ length: 7 }).map((__, c) => (
                      <td key={c} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-slate-200" /></td>
                    ))}
                  </tr>
                ))
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-2 text-slate-400">
                      <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-xs font-semibold">Không có transfer nào trong danh sách này.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                sorted.map((item, i) => {
                  const badge = getStatusBadge(item.payosTransferStatus);
                  const isEmergency = item.requestMode === 'EMERGENCY';
                  return (
                    <tr
                      key={item.requestId}
                      className={`border-t border-slate-100 transition ${isEmergency ? 'bg-red-50/40' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-cyan-700">
                          {item.requestId.slice(0, 16)}...
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs font-semibold text-slate-700">{item.projectId.slice(0, 12)}...</p>
                        {isEmergency && (
                          <span className="mt-0.5 inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                            🚨 EMERGENCY
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-700">
                        {new Intl.NumberFormat('vi-VN').format(item.amount)}₫
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.payosTransferStatus === 'PROCESSING' ? (
                          <CountdownTimer updatedAt={item.updatedAt} attemptCount={item.payosTransferAttemptCount} />
                        ) : (
                          <span className="text-xs text-slate-500">×{item.payosTransferAttemptCount}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {new Date(item.updatedAt).toLocaleString('vi-VN')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {item.payosTransferStatus === 'MANUAL_REVIEW' && (
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setDialog({ requestId: item.requestId, projectId: item.projectId, amount: item.amount, mode: 'approve' })}
                              className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-600 hover:text-white transition"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => setDialog({ requestId: item.requestId, projectId: item.projectId, amount: item.amount, mode: 'reject' })}
                              className="rounded-lg border border-red-200 px-2.5 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-600 hover:text-white transition"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                        {item.payosTransferStatus === 'PROCESSING' && (
                          <span className="text-[11px] text-slate-400">Đang xử lý...</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialog */}
      {dialog && (
        <ManualReviewDialog
          {...dialog}
          onClose={() => setDialog(null)}
          onSuccess={handleDialogSuccess}
          onError={(msg) => onPushToast?.({ titleText: 'Lỗi', bodyText: msg, tone: 'error' })}
        />
      )}
    </div>
  );
}
