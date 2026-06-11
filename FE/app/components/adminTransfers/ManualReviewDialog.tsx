'use client';

// =============================================================================
// ManualReviewDialog — A4: dialog approve/reject thủ công
// Approve: confirmation đơn giản
// Reject: textarea reason (≥ 10 ký tự, bắt buộc)
// =============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

type DialogMode = 'approve' | 'reject';

type ManualReviewDialogProps = {
  requestId: string;
  projectId: string;
  amount: number;
  mode: DialogMode;
  onClose: () => void;
  onSuccess: (requestId: string, mode: DialogMode) => void;
  onError?: (msg: string) => void;
};

/**
 * Dialog xác nhận approve/reject một disbursement đang MANUAL_REVIEW.
 * - Approve: gọi POST /api/disbursements/:id/manual-approve
 * - Reject: gọi POST /api/disbursements/:id/manual-reject với reason ≥ 10 ký tự
 */
export default function ManualReviewDialog({
  requestId,
  projectId,
  amount,
  mode,
  onClose,
  onSuccess,
  onError
}: ManualReviewDialogProps) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  const isApprove = mode === 'approve';
  const reasonValid = isApprove || reason.trim().length >= 10;

  // Escape để đóng + focus element đầu tiên khi mở
  useEffect(() => {
    firstFocusRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      // Focus trap: giữ Tab trong dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input')
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (!reasonValid) {
      setErrorMsg('Lý do phải có ít nhất 10 ký tự.');
      return;
    }
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      const session = readAuthSession();
      const endpoint = isApprove ? 'manual-approve' : 'manual-reject';
      await fetchApi(
        buildApiUrl(`/api/disbursements/${requestId}/${endpoint}`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`
          },
          body: isApprove ? undefined : JSON.stringify({ reason: reason.trim() })
        }
      );
      onSuccess(requestId, mode);
      onClose();
    } catch (err) {
      const msg = (err as Error)?.message || 'Thao tác thất bại. Vui lòng thử lại.';
      setErrorMsg(msg);
      onError?.(msg);
    } finally {
      setIsSubmitting(false);
    }
  }, [isApprove, reason, reasonValid, requestId, mode, onClose, onSuccess, onError]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div ref={dialogRef} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="dialog-title" className={`text-base font-bold ${isApprove ? 'text-emerald-700' : 'text-red-700'}`}>
              {isApprove ? 'Xác nhận Approve thủ công' : 'Xác nhận Reject disbursement'}
            </h3>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{requestId}</p>
          </div>
          <button ref={firstFocusRef} type="button" onClick={onClose} aria-label="Đóng dialog" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Info */}
        <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <p>Project: <span className="font-semibold text-slate-800">{projectId}</span></p>
          <p className="mt-0.5">
            Số tiền:{' '}
            <span className="font-semibold text-slate-800">
              {new Intl.NumberFormat('vi-VN').format(amount)}₫
            </span>
          </p>
        </div>

        {/* Approve confirmation */}
        {isApprove && (
          <p className="mt-4 text-xs text-slate-600">
            Hành động này sẽ <span className="font-semibold text-emerald-700">đẩy lại vào queue</span> để retry
            PayOS transfer từ đầu (reset về attempt 1). Xác nhận?
          </p>
        )}

        {/* Reject reason */}
        {!isApprove && (
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-700">
              Lý do reject <span className="text-red-500">*</span>
              <span className="ml-1 font-normal text-slate-400">(tối thiểu 10 ký tự)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Nhập lý do từ chối chuyển khoản..."
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-200"
            />
            <p className={`mt-0.5 text-[11px] ${reason.trim().length < 10 ? 'text-slate-400' : 'text-emerald-600'}`}>
              {reason.trim().length}/10 ký tự tối thiểu
            </p>
          </div>
        )}

        {errorMsg && (
          <p className="mt-2 text-xs text-red-600">{errorMsg}</p>
        )}

        {/* Actions */}
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
            disabled={isSubmitting || !reasonValid}
            className={`rounded-lg px-4 py-2 text-xs font-bold text-white disabled:opacity-50 ${
              isApprove
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {isSubmitting
              ? 'Đang xử lý...'
              : isApprove
              ? 'Xác nhận Approve'
              : 'Xác nhận Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
