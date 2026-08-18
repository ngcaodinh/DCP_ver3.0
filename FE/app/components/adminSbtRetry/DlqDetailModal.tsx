'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import type { SbtMintDlqEntry } from '@/app/types/sbtRetry';

type DlqModalPhase = 'detail' | 'confirm';

interface DlqDetailModalProps {
  entry: SbtMintDlqEntry;
  initialPhase?: DlqModalPhase;
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

/** Định dạng timestamp API theo locale Việt Nam để admin dễ đối chiếu lịch sử retry. */
function formatDlqDateTime(timestamp: string | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('vi-VN');
}

/** Modal chi tiết DLQ với một overlay và hai pha detail/confirm để tránh modal lồng nhau. */
export default function DlqDetailModal({
  entry,
  initialPhase = 'detail',
  isSubmitting,
  onClose,
  onConfirm,
  returnFocusRef
}: DlqDetailModalProps): ReactElement {
  const [phase, setPhase] = useState<DlqModalPhase>(initialPhase);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const firstFocusableElement = dialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    firstFocusableElement?.focus();

    /** Đóng modal bằng Escape và giữ focus trong overlay khi admin nhấn Tab. */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isSubmitting) {
        event.preventDefault();
        onCloseRef.current();
        returnFocusRef?.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) return;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSubmitting, phase, returnFocusRef]);

  /** Đóng modal từ các nút giao diện và trả focus về control đã mở modal. */
  const handleClose = useCallback((): void => {
    if (isSubmitting) return;
    onClose();
    returnFocusRef?.current?.focus();
  }, [isSubmitting, onClose, returnFocusRef]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-3 py-3 sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sbt-dlq-dialog-title"
      aria-describedby="sbt-dlq-dialog-description"
    >
      <div ref={dialogRef} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="sbt-dlq-dialog-title" className="text-base font-bold text-slate-900">
              {phase === 'detail' ? 'Chi tiết job SBT lỗi' : 'Xác nhận chạy lại job'}
            </h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{entry.mintRequestId}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Đóng dialog"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {phase === 'detail' ? (
          <>
            <p id="sbt-dlq-dialog-description" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Nếu job đã được chạy lại và hỏng tiếp, thông báo lỗi ở đây vẫn là lỗi của lần vào DLQ đầu tiên.
            </p>
            {entry.lastRecoveryError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
                <p className="font-semibold">Lỗi recovery gần nhất ({formatDlqDateTime(entry.lastRecoveryAt ?? null)})</p>
                <p className="mt-1 break-words">{entry.lastRecoveryError}</p>
              </div>
            )}
            <div className="mt-4 space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lỗi đầy đủ</h3>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                  {entry.lastErrorMessage}
                </pre>
              </div>
              <dl className="grid gap-3 text-xs sm:grid-cols-2">
                <div><dt className="text-slate-500">Project</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.projectName ?? entry.projectId}</dd></div>
                <div><dt className="text-slate-500">Project ID</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.projectId}</dd></div>
                <div><dt className="text-slate-500">SBT ID</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.sbtId}</dd></div>
                <div><dt className="text-slate-500">Mint request ID</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.mintRequestId}</dd></div>
                <div><dt className="text-slate-500">Organization ID</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.organizationId}</dd></div>
                <div><dt className="text-slate-500">Beneficiary</dt><dd className="mt-1 break-all font-mono text-slate-800">{entry.beneficiaryAddress}</dd></div>
                <div><dt className="text-slate-500">Lần thử cuối</dt><dd className="mt-1 text-slate-800">{entry.attemptNumber}</dd></div>
                <div><dt className="text-slate-500">Số lần chạy lại</dt><dd className="mt-1 text-slate-800">{entry.recoveryAttemptNumber}</dd></div>
                <div><dt className="text-slate-500">Lần thử đầu</dt><dd className="mt-1 text-slate-800">{formatDlqDateTime(entry.firstAttemptedAt)}</dd></div>
                <div><dt className="text-slate-500">Vào DLQ</dt><dd className="mt-1 text-slate-800">{formatDlqDateTime(entry.dlqAt)}</dd></div>
                <div><dt className="text-slate-500">Trạng thái</dt><dd className="mt-1 text-slate-800">{entry.status}</dd></div>
              </dl>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={handleClose} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                Đóng
              </button>
              {entry.status === 'OPEN' && (
                <button type="button" onClick={() => setPhase('confirm')} className="rounded-lg bg-[#0E7C6B] px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700">
                  Chạy lại
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p id="sbt-dlq-dialog-description" className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              Hệ thống sẽ reset job và đưa lại qua worker. Không mint trực tiếp từ giao diện quản trị.
            </p>
            <p className="mt-3 text-xs text-slate-600">Job vẫn còn trong danh sách cho tới khi worker mint thành công và BE chuyển trạng thái sang RECOVERED.</p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setPhase('detail')} disabled={isSubmitting} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                Hủy
              </button>
              <button type="button" onClick={onConfirm} disabled={isSubmitting} className="rounded-lg bg-[#0E7C6B] px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                {isSubmitting ? 'Đang xử lý...' : 'Xác nhận chạy lại'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
