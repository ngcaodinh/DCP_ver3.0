'use client';

// =============================================================================
// /admin/transfers/[transferId] — A4: Detail page
// Hiển thị chi tiết một disbursement MANUAL_REVIEW kèm:
//   - Full retry log timeline
//   - Audit log admin actions
//   - Approve / Reject buttons
// =============================================================================

import { useState, useCallback, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import ManualReviewDialog from '@/app/components/adminTransfers/ManualReviewDialog';

// ============ TYPES ============

type TransferLog = {
  transferLogId: string;
  attemptNumber: number;
  payosTransferId: string | null;
  amount: number;
  status: string;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
};

type AuditLog = {
  auditId: string;
  adminUserId: string;
  action: 'MANUAL_APPROVE' | 'MANUAL_REJECT' | 'MANUAL_BANK_ACCOUNT_VIEW';
  reason: string | null;
  createdAt: string;
};

type DetailData = {
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  status: string;
  payosTransferStatus: string | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
  };
  updatedAt: string;
  createdAt: string;
  transferLogs: TransferLog[];
  auditLogs: AuditLog[];
};

// ============ HELPERS ============

function getTransferLogStatusBadge(status: string) {
  switch (status) {
    case 'SUCCESS':      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'FAILED':       return 'bg-red-100 text-red-800 border-red-200';
    case 'PROCESSING':   return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'MANUAL_REVIEW':return 'bg-amber-100 text-amber-800 border-amber-200';
    default:             return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

// ============ MAIN PAGE ============

export default function TransferDetailPage() {
  const params = useParams<{ transferId: string }>();
  const router = useRouter();
  const transferId = params.transferId;

  const [data, setData] = useState<DetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'approve' | 'reject' } | null>(null);
  const [isBankAccountRevealed, setIsBankAccountRevealed] = useState(false);

  /** Tải detail manual review và chỉ gửi cờ reveal khi admin chủ động yêu cầu xem PII. */
  const loadDetail = useCallback(async (revealBankAccount = false) => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const session = readAuthSession();
      const response = await fetchApi<DetailData>(
        buildApiUrl(`/api/disbursements/${transferId}/detail${revealBankAccount ? '?revealBankAccount=true' : ''}`),
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      setData(response.data);
      setIsBankAccountRevealed(revealBankAccount);
    } catch {
      setErrorMsg('Không thể tải chi tiết transfer. Disbursement có thể không ở trạng thái MANUAL_REVIEW.');
    } finally {
      setIsLoading(false);
    }
  }, [transferId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-white" />
          ))}
        </div>
      </main>
    );
  }

  if (errorMsg || !data) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl rounded-xl border border-red-200 bg-red-50 px-6 py-8 text-center">
          <p className="text-sm font-semibold text-red-700">{errorMsg || 'Không tìm thấy dữ liệu.'}</p>
          <button type="button" onClick={() => router.back()} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700">
            ← Quay lại
          </button>
        </div>
      </main>
    );
  }

  const isManualReview = data.payosTransferStatus === 'MANUAL_REVIEW';

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-5">
        {/* Breadcrumb */}
        <nav className="text-xs text-slate-400">
          <a href="/admin" className="hover:text-slate-600">Admin</a>
          <span className="mx-1.5">›</span>
          <a href="/admin/transfers" className="hover:text-slate-600">Transfer Queue</a>
          <span className="mx-1.5">›</span>
          <span className="font-mono text-slate-600">{transferId.slice(0, 16)}...</span>
        </nav>

        {/* EMERGENCY banner */}
        {data.requestMode === 'EMERGENCY' && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3">
            <span className="text-xl">🚨</span>
            <div>
              <p className="text-sm font-bold text-red-800">Giao dịch khẩn cấp</p>
              {data.emergencyReason && <p className="text-xs text-red-700">{data.emergencyReason}</p>}
            </div>
          </div>
        )}

        {/* Disbursement info */}
        <div className="rounded-xl border border-emerald-900/15 bg-white px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-base font-bold text-slate-900">Chi tiết Disbursement</h1>
              <p className="mt-0.5 font-mono text-xs text-slate-500">{data.requestId}</p>
            </div>
            {isManualReview && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDialog({ mode: 'approve' })}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setDialog({ mode: 'reject' })}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 text-xs">
            {[
              ['Project ID', data.projectId],
              ['Org ID', data.organizationId],
              ['Số tiền', `${new Intl.NumberFormat('vi-VN').format(data.amount)}₫`],
              ['Transfer status', data.payosTransferStatus ?? '—'],
              ['Disbursement status', data.status],
              ['Retry count', String(data.payosTransferAttemptCount)]
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-[10px] text-slate-400">{label}</p>
                <p className="mt-0.5 font-semibold text-slate-700 break-all">{value}</p>
              </div>
            ))}
          </div>
          {data.payosTransferLastError && (
            <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
              <p className="text-[10px] text-red-500">Lỗi cuối cùng:</p>
              <p className="mt-0.5 text-xs text-red-700">{data.payosTransferLastError}</p>
            </div>
          )}
          <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-slate-400">Tài khoản thụ hưởng</p>
              {!isBankAccountRevealed && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => void loadDetail(true)}
                  className="rounded border border-amber-300 px-2 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                >
                  Hiện số tài khoản
                </button>
              )}
            </div>
            <p className="mt-0.5 font-semibold text-slate-700">{data.beneficiaryBankAccount.accountHolderName}</p>
            <p className="text-slate-500">{data.beneficiaryBankAccount.bankName} — {data.beneficiaryBankAccount.bankAccountNumber}</p>
          </div>
        </div>

        {/* Retry log timeline */}
        <div className="rounded-xl border border-emerald-900/15 bg-white px-6 py-5">
          <h2 className="text-sm font-bold text-slate-900">Retry Log Timeline</h2>
          <p className="mt-0.5 text-xs text-slate-500">{data.transferLogs.length} lần thử</p>
          <div className="mt-4 space-y-3">
            {data.transferLogs.length === 0 ? (
              <p className="text-xs text-slate-400">Chưa có transfer log nào.</p>
            ) : (
              data.transferLogs.map((log) => (
                <div key={log.transferLogId} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${getTransferLogStatusBadge(log.status)}`}>
                      {log.attemptNumber}
                    </div>
                    <div className="w-px flex-1 bg-slate-200" />
                  </div>
                  <div className="mb-3 flex-1 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold ${getTransferLogStatusBadge(log.status)}`}>
                        {log.status}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(log.startedAt).toLocaleString('vi-VN')}
                        {log.durationMs != null && ` · ${log.durationMs}ms`}
                      </span>
                    </div>
                    {log.payosTransferId && (
                      <p className="mt-1 font-mono text-[10px] text-slate-500">PayOS ID: {log.payosTransferId}</p>
                    )}
                    {log.errorMessage && (
                      <p className="mt-1 text-[11px] text-red-600">{log.errorMessage}</p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Audit log */}
        {data.auditLogs.length > 0 && (
          <div className="rounded-xl border border-emerald-900/15 bg-white px-6 py-5">
            <h2 className="text-sm font-bold text-slate-900">Admin Audit Log</h2>
            <div className="mt-3 space-y-2">
              {data.auditLogs.map((log) => (
                <div key={log.auditId} className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${log.action === 'MANUAL_APPROVE' ? 'border-emerald-200 bg-emerald-50' : log.action === 'MANUAL_BANK_ACCOUNT_VIEW' ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
                  <span className={`mt-0.5 text-[11px] font-bold ${log.action === 'MANUAL_APPROVE' ? 'text-emerald-700' : log.action === 'MANUAL_BANK_ACCOUNT_VIEW' ? 'text-amber-700' : 'text-red-700'}`}>
                    {log.action === 'MANUAL_APPROVE' ? 'APPROVE' : log.action === 'MANUAL_BANK_ACCOUNT_VIEW' ? 'VIEW BANK ACCOUNT' : 'REJECT'}
                  </span>
                  <div className="flex-1 text-xs">
                    <p className="text-slate-600">Admin: <span className="font-semibold text-slate-800">{log.adminUserId.slice(0, 16)}...</span></p>
                    {log.reason && <p className="mt-0.5 text-slate-600">Lý do: {log.reason}</p>}
                    <p className="mt-0.5 text-[10px] text-slate-400">{new Date(log.createdAt).toLocaleString('vi-VN')}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {dialog && data && (
        <ManualReviewDialog
          requestId={data.requestId}
          projectId={data.projectId}
          amount={data.amount}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onSuccess={() => {
            setDialog(null);
            router.push('/admin/transfers');
          }}
        />
      )}
    </main>
  );
}
