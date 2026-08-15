'use client';

import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import type { FlaggedFeedbackItem } from './types';

interface FeedbackDetailModalProps {
  item: FlaggedFeedbackItem;
  deletionState: 'active' | 'deleted';
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

/** Modal detail feedback có focus trap, Escape và chỉ render field thuộc contract allowlist. */
export function FeedbackDetailModal({
  item,
  deletionState,
  onClose,
  returnFocusRef
}: FeedbackDetailModalProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])')
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
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" role="dialog" aria-modal="true" aria-labelledby="feedback-detail-title">
      <div ref={dialogRef} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="feedback-detail-title" className="text-lg font-bold text-slate-900">Chi tiết feedback</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{item.feedbackId}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Đóng chi tiết feedback" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>

        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{item.comment}</p>
        </div>

        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <DetailField label="Project" value={item.projectName ?? item.projectId} />
          <DetailField label="Project ID" value={item.projectId} />
          <DetailField label="Rating" value={`${item.rating}/5`} />
          <DetailField label="Risk score" value={`${item.riskScore}/10`} />
          <DetailField label="Nguồn" value={item.source === 'batch' ? 'NGO upload' : 'Form công khai'} />
          <DetailField label="Thời điểm gửi" value={formatDate(item.submittedAt)} />
          <DetailField label="Địa điểm" value={item.location ?? 'Không cung cấp'} />
          <DetailField label="Loại flag" value={item.flagReason.kind} />
          <DetailField label="Chỉ báo" value={item.flagReason.indicators.join(', ') || 'Không có'} />
          {item.flagReason.kind === 'MANUAL' && <DetailField label="Lý do admin" value={item.flagReason.adminReason ?? 'Không có'} />}
          {item.flagReason.kind === 'MANUAL' && <DetailField label="Admin flag" value={item.flagReason.flaggedByAdminId ?? 'Không xác định'} />}
          {item.flagReason.kind === 'MANUAL' && <DetailField label="Thời điểm flag" value={formatDate(item.flagReason.flaggedAt)} />}
        </dl>

        <p className="mt-5 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Hệ thống không lưu danh tính người gửi phản hồi.
        </p>

        {deletionState === 'deleted' && (
          <dl className="mt-4 grid gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm sm:grid-cols-2">
            <DetailField label="Lý do xoá" value={item.deleteReason ?? 'Không có'} />
            <DetailField label="Admin xoá" value={item.deletedByAdminId ?? 'Không xác định'} />
            <DetailField label="Xoá lúc" value={formatDate(item.deletedAt)} />
            <DetailField label="Purge lúc" value={formatDate(item.purgeAfter)} />
          </dl>
        )}

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Đóng</button>
        </div>
      </div>
    </div>
  );
}

interface DetailFieldProps {
  label: string;
  value: string;
}

/** Render một field metadata an toàn, không dùng Object.entries trên payload động. */
function DetailField({ label, value }: DetailFieldProps): ReactElement {
  return <div><dt className="text-xs font-medium text-slate-500">{label}</dt><dd className="mt-0.5 break-words text-slate-800">{value}</dd></div>;
}

/** Format timestamp theo timezone Việt Nam cho detail modal. */
function formatDate(value: string | undefined | null): string {
  if (!value) return 'Không xác định';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không xác định';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}
