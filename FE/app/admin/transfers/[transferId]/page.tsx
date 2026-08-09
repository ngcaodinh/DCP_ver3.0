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
import { fetchApi, buildApiUrl, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import ManualReviewDialog from '@/app/components/adminTransfers/ManualReviewDialog';
import CountdownTimer from '@/app/components/adminTransfers/CountdownTimer';

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
  queueId: string;
  reviewCycle: number;
  assignedAdminId: string | null;
  assignmentMethod: 'PROJECT_AFFINITY' | 'ROUND_ROBIN' | 'LEAST_LOADED' | 'UNASSIGNED';
  slaDeadline: string;
  escalatedAt: string | null;
  nextRetryAt: null;
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

/** Phân loại lỗi detail theo contract A3 để admin biết dữ liệu đã resolve hay request hỏng. */
function getDetailErrorMessage(error: unknown): string {
  const apiError = error as Partial<ApiErrorResponse>;
  if (apiError.statusCode === 404) return 'Không tìm thấy disbursement này.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'INVALID_STATUS_TRANSITION') {
    return 'Item đã được xử lý hoặc dữ liệu chưa backfill A3; xem lại lịch sử ở dashboard.';
  }
  if (apiError.statusCode === 401) return 'Phiên đăng nhập đã hết hạn hoặc authVersion đã thay đổi. Vui lòng đăng nhập lại.';
  if (apiError.statusCode === 403) return 'Tài khoản không còn quyền admin.';
  if (apiError.statusCode && apiError.statusCode >= 500) return 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại.';
  return 'Không thể tải chi tiết transfer. Vui lòng thử lại.';
}

// ============ MAIN PAGE ============

export default function TransferDetailPage() {
  const params = useParams<{ transferId: string }>();
  const router = useRouter();
  const transferId = params.transferId;

  const [data, setData] = useState<DetailData | null>(null);
  const [isAuthorised, setIsAuthorised] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'approve' | 'reject' } | null>(null);
  const [isBankAccountRevealed, setIsBankAccountRevealed] = useState(false);

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      return;
    }
    if (session.userRole !== 'admin') {
      router.replace('/unauthorized');
      return;
    }
    setIsAuthorised(true);
    setIsCheckingAuth(false);
  }, [router]);

  /** Tải detail manual review và chỉ gửi cờ reveal khi admin chủ động yêu cầu xem PII. */
  const loadDetail = useCallback(async (revealBankAccount = false) => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const session = readAuthSession();
      const response = await fetchApi<DetailData>(
        buildApiUrl(`/api/disbursements/${encodeURIComponent(transferId)}/detail${revealBankAccount ? '?revealBankAccount=true' : ''}`),
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      setData(response.data);
      setIsBankAccountRevealed(revealBankAccount);
    } catch (error) {
      setErrorMsg(getDetailErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [transferId]);

  /** Ẩn PII ngay lập tức và tải lại DTO masked để số tài khoản không còn trong màn hình. */
  const handleHideBankAccount = useCallback(() => {
    setIsBankAccountRevealed(false);
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (isAuthorised) void loadDetail();
  }, [isAuthorised, loadDetail]);

  if (isCheckingAuth) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</main>;
  }
  if (!isAuthorised) return null;

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
          <a href="/admin/transfers" className="mt-4 inline-flex rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700">← Về danh sách</a>
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
              {isBankAccountRevealed ? (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={handleHideBankAccount}
                  className="rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                >
                  Ẩn số tài khoản
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    if (window.confirm('Hành động này sẽ được ghi audit MANUAL_BANK_ACCOUNT_VIEW. Tiếp tục?')) {
                      void loadDetail(true);
                    }
                  }}
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

        {/* Queue & SLA snapshot */}
        <div className="rounded-xl border border-emerald-900/15 bg-white px-6 py-5">
          <h2 className="text-sm font-bold text-slate-900">Queue & SLA</h2>
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">Queue ID</p><p className="mt-0.5 break-all font-mono font-semibold text-slate-700">{data.queueId}</p></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">Review cycle</p><p className="mt-0.5 font-semibold text-slate-700">{data.reviewCycle}</p></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">Assigned admin</p><p className="mt-0.5 break-all font-semibold text-slate-700">{data.assignedAdminId ?? 'Chưa assign'}</p></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">Assignment method</p><p className="mt-0.5 font-semibold text-slate-700">{data.assignmentMethod}</p></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">SLA</p><CountdownTimer deadline={data.slaDeadline} escalatedAt={data.escalatedAt} /></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[10px] text-slate-400">Escalated at</p><p className="mt-0.5 font-semibold text-slate-700">{data.escalatedAt ? new Date(data.escalatedAt).toLocaleString('vi-VN') : 'Chưa escalate'}</p></div>
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
              [...data.transferLogs].sort((firstLog, secondLog) => firstLog.attemptNumber - secondLog.attemptNumber).map((log) => (
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
                        {log.completedAt && ` → ${new Date(log.completedAt).toLocaleString('vi-VN')}`}
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
