'use client';

import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import { fetchApi, buildApiUrl, type ApiErrorResponse } from '@/app/utils/apiClient';
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
  onRefresh?: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
};

/** Chuyển lỗi action A3 thành thông điệp an toàn, phản ánh đúng trạng thái PayOS. */
function getManualReviewActionErrorMessage(error: unknown): string {
  const apiError = error as Partial<ApiErrorResponse>;
  if (apiError.statusCode === 409) {
    return 'PayOS đang xử lý hoặc đã thành công; chờ webhook đối soát rồi thử lại.';
  }
  if (apiError.statusCode === 400 && apiError.errorCode === 'INVALID_STATUS_TRANSITION') {
    return 'Item không còn ở trạng thái manual review.';
  }
  if (apiError.statusCode === 404) {
    return 'Không tìm thấy item manual review; danh sách sẽ được làm mới.';
  }
  if (apiError.statusCode === 429) {
    return 'Bạn đã vượt giới hạn 20 thao tác/phút; vui lòng thử lại sau.';
  }
  if (apiError.statusCode === 503) {
    return 'Dịch vụ tạm thời không khả dụng; vui lòng thử lại sau.';
  }
  if (apiError.statusCode === 400 && typeof apiError.message === 'string') {
    return apiError.message;
  }
  return 'Thao tác thất bại. Vui lòng thử lại.';
}

/** Dialog xác nhận approve/reject một disbursement đang MANUAL_REVIEW. */
export default function ManualReviewDialog({
  requestId,
  projectId,
  amount,
  mode,
  onClose,
  onSuccess,
  onError,
  onRefresh,
  returnFocusRef
}: ManualReviewDialogProps) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  const isApprove = mode === 'approve';
  const trimmedReasonLength = reason.trim().length;
  const reasonValid = isApprove || (trimmedReasonLength >= 10 && trimmedReasonLength <= 1000);

  useEffect(() => {
    const focusReturnTarget = returnFocusRef?.current;
    firstFocusRef.current?.focus();
    return () => {
      focusReturnTarget?.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusableElements = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input')
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement?.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  /** Gửi action sau khi local validation đã khớp validator BE. */
  const handleSubmit = useCallback(async () => {
    if (!reasonValid) {
      setErrorMsg('reason phải dài từ 10 đến 1000 ký tự.');
      return;
    }
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      const session = readAuthSession();
      const endpoint = isApprove ? 'manual-approve' : 'manual-reject';
      await fetchApi(
        buildApiUrl(`/api/disbursements/${encodeURIComponent(requestId)}/${endpoint}`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.accessToken}` },
          body: isApprove ? undefined : JSON.stringify({ reason: reason.trim() })
        }
      );
      onSuccess(requestId, mode);
      onClose();
    } catch (error) {
      const apiError = error as Partial<ApiErrorResponse>;
      const message = getManualReviewActionErrorMessage(error);
      setErrorMsg(message);
      onError?.(message);
      if (apiError.statusCode === 404 || (apiError.statusCode === 400 && apiError.errorCode === 'INVALID_STATUS_TRANSITION')) {
        onRefresh?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [isApprove, mode, onClose, onError, onRefresh, onSuccess, reason, reasonValid, requestId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description">
      <div ref={dialogRef} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="dialog-title" className={`text-base font-bold ${isApprove ? 'text-emerald-700' : 'text-red-700'}`}>
              {isApprove ? 'Xác nhận Approve thủ công' : 'Xác nhận Reject disbursement'}
            </h3>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{requestId}</p>
          </div>
          <button ref={firstFocusRef} type="button" onClick={onClose} aria-label="Đóng dialog" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <p>Project: <span className="font-semibold text-slate-800">{projectId}</span></p>
          <p className="mt-0.5">Số tiền: <span className="font-semibold text-slate-800">{new Intl.NumberFormat('vi-VN').format(amount)}₫</span></p>
        </div>

        {isApprove && (
          <p id="dialog-description" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hệ thống sẽ đối soát PayOS trước, chỉ enqueue lại khi provider xác nhận trạng thái terminal an toàn. Kết quả là <span className="font-semibold">PROCESSING</span> và chờ webhook xác nhận. Xác nhận?
          </p>
        )}

        {!isApprove && (
          <div id="dialog-description" className="mt-4">
            <label className="block text-xs font-semibold text-slate-700" htmlFor="manual-review-reason">
              Lý do reject <span className="text-red-500">*</span>
              <span className="ml-1 font-normal text-slate-400">(10–1000 ký tự)</span>
            </label>
            <textarea
              id="manual-review-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Nhập lý do từ chối chuyển khoản..."
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-200"
            />
            <p className={`mt-0.5 text-[11px] ${reasonValid ? 'text-emerald-600' : 'text-slate-400'}`}>
              {trimmedReasonLength}/1000 ký tự
            </p>
          </div>
        )}

        {errorMsg && <p className="mt-2 text-xs text-red-600" role="alert">{errorMsg}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={isSubmitting} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            Hủy
          </button>
          <button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !reasonValid} className={`rounded-lg px-4 py-2 text-xs font-bold text-white disabled:opacity-50 ${isApprove ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
            {isSubmitting ? 'Đang xử lý...' : isApprove ? 'Xác nhận Approve' : 'Xác nhận Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
