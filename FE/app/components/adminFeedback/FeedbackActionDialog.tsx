'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type { FeedbackActionMode } from './types';

interface FeedbackActionDialogProps {
  feedbackId: string;
  mode: FeedbackActionMode;
  onClose: () => void;
  onSuccess: (mode: FeedbackActionMode) => void;
  onRefresh: () => void | Promise<void>;
  onForbidden: () => void;
  onNotice?: (message: string, tone: 'info' | 'warning' | 'error') => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

/** Ánh xạ lỗi moderation theo trạng thái cạnh tranh và cửa sổ purge, không báo sai là lỗi hệ thống. */
export function getFeedbackActionErrorMessage(error: unknown, mode: FeedbackActionMode): string {
  const apiError = error as Partial<ApiErrorResponse>;
  if (apiError.statusCode === 409 && apiError.errorCode === 'FEEDBACK_ALREADY_DELETED') {
    return 'Feedback đã được xoá trước đó.';
  }
  if (apiError.statusCode === 409 && apiError.errorCode === 'FEEDBACK_NOT_DELETED') {
    return 'Feedback này chưa bị xoá.';
  }
  if (apiError.statusCode === 409 && apiError.errorCode === 'FEEDBACK_NOT_FLAGGED') {
    return 'Feedback này chưa bị flag, không thể xoá.';
  }
  if (apiError.statusCode === 409) {
    return 'Feedback đã được admin khác xử lý. Danh sách đã được làm mới.';
  }
  if (apiError.statusCode === 404 && mode === 'restore') {
    return 'Feedback đã quá hạn 30 ngày và bị xoá vĩnh viễn, không khôi phục được.';
  }
  if (apiError.statusCode === 404) {
    return 'Feedback không còn tồn tại.';
  }
  if (apiError.statusCode === 400 && typeof apiError.message === 'string') {
    return apiError.message;
  }
  if (apiError.statusCode === 403) {
    return 'Tài khoản không còn quyền admin.';
  }
  if (apiError.statusCode === 429) {
    return 'Đã vượt 30 thao tác/phút. Thử lại sau ít phút.';
  }
  if (typeof apiError.statusCode === 'number' && apiError.statusCode >= 500) {
    return 'Hệ thống đang bận. Vui lòng thử lại.';
  }
  return 'Thao tác thất bại. Vui lòng thử lại.';
}

/** Dialog xác nhận unflag/delete/restore với validator reason đồng bộ BE và focus trap đầy đủ. */
export default function FeedbackActionDialog({
  feedbackId,
  mode,
  onClose,
  onSuccess,
  onRefresh,
  onForbidden,
  onNotice,
  returnFocusRef
}: FeedbackActionDialogProps): ReactElement {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reasonLength = reason.trim().length;
  const reasonValid = reasonLength >= 10 && reasonLength <= 1000;

  useEffect(() => {
    const focusReturnTarget = returnFocusRef?.current;
    closeButtonRef.current?.focus();
    return () => focusReturnTarget?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusableElements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input'));
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /** Gửi action sau khi reason local đã đạt cùng biên 10–1000 ký tự với BE. */
  const handleSubmit = useCallback(async () => {
    if (!reasonValid) {
      setErrorMessage('reason phải dài từ 10 đến 1000 ký tự.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const session = readAuthSession();
      const endpoint = mode === 'unflag'
        ? `/api/feedback/${encodeURIComponent(feedbackId)}/unflag`
        : mode === 'delete'
          ? `/api/feedback/${encodeURIComponent(feedbackId)}`
          : `/api/feedback/${encodeURIComponent(feedbackId)}/restore`;
      await fetchApi(buildApiUrl(endpoint), {
        method: mode === 'delete' ? 'DELETE' : 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ reason: reason.trim() })
      });
      onSuccess(mode);
      onClose();
    } catch (error) {
      const apiError = error as Partial<ApiErrorResponse>;
      const message = getFeedbackActionErrorMessage(error, mode);
      setErrorMessage(message);
      if (apiError.statusCode === 403) {
        onNotice?.(message, 'error');
        onForbidden();
      }
      if (apiError.statusCode === 409 || apiError.statusCode === 404) {
        const tone = apiError.statusCode === 409 ? 'info' : mode === 'restore' ? 'warning' : 'info';
        onNotice?.(message, tone);
        await onRefresh();
        onClose();
      } else if (apiError.statusCode === 429) {
        onNotice?.(message, 'warning');
      } else if (typeof apiError.statusCode === 'number' && apiError.statusCode >= 500) {
        onNotice?.(message, 'error');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [feedbackId, mode, onClose, onForbidden, onNotice, onRefresh, onSuccess, reason, reasonValid]);

  const copy = getDialogCopy(mode);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" role="dialog" aria-modal="true" aria-labelledby="feedback-action-title" aria-describedby="feedback-action-description">
      <div ref={dialogRef} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="feedback-action-title" className={`text-base font-bold ${copy.titleClassName}`}>{copy.title}</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{feedbackId}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Đóng dialog thao tác feedback" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">✕</button>
        </div>

        <p id="feedback-action-description" className={`mt-4 rounded-lg border px-3 py-2 text-xs ${copy.descriptionClassName}`}>
          {copy.description}
        </p>

        <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="feedback-action-reason">
          Lý do <span className="text-red-500">*</span> <span className="font-normal text-slate-400">(10–1000 ký tự)</span>
        </label>
        <textarea
          id="feedback-action-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1000}
          rows={4}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
          placeholder="Nhập lý do để lưu audit trail..."
        />
        <p className={`mt-0.5 text-[11px] ${reasonValid ? 'text-emerald-600' : 'text-slate-400'}`}>{reasonLength}/1000 ký tự</p>

        {errorMessage && <p className="mt-2 text-xs text-red-600" role="alert">{errorMessage}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={isSubmitting} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Hủy</button>
          <button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !reasonValid} className={`rounded-lg px-4 py-2 text-xs font-bold text-white disabled:opacity-50 ${copy.buttonClassName}`}>
            {isSubmitting ? 'Đang xử lý...' : copy.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DialogCopy {
  title: string;
  description: string;
  submitLabel: string;
  titleClassName: string;
  descriptionClassName: string;
  buttonClassName: string;
}

/** Trả nội dung xác nhận riêng cho từng action destructive hoặc restore. */
function getDialogCopy(mode: FeedbackActionMode): DialogCopy {
  if (mode === 'delete') {
    return {
      title: 'Hành động không thể hoàn tác',
      description: 'Bản ghi được giữ 30 ngày rồi xoá vĩnh viễn.',
      submitLabel: 'Xác nhận xoá',
      titleClassName: 'text-red-700',
      descriptionClassName: 'border-red-200 bg-red-50 text-red-800',
      buttonClassName: 'bg-red-600 hover:bg-red-700'
    };
  }
  if (mode === 'restore') {
    return {
      title: 'Khôi phục feedback này?',
      description: 'Feedback sẽ quay lại danh sách đang bị flag, chưa hiển thị công khai.',
      submitLabel: 'Xác nhận khôi phục',
      titleClassName: 'text-blue-700',
      descriptionClassName: 'border-blue-200 bg-blue-50 text-blue-800',
      buttonClassName: 'bg-blue-600 hover:bg-blue-700'
    };
  }
  return {
    title: 'Bạn có chắc muốn bỏ flag?',
    description: 'Feedback sẽ được đưa trở lại trạng thái hiển thị công khai sau khi bỏ flag.',
    submitLabel: 'Xác nhận bỏ flag',
    titleClassName: 'text-emerald-700',
    descriptionClassName: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    buttonClassName: 'bg-emerald-600 hover:bg-emerald-700'
  };
}
