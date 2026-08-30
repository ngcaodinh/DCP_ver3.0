'use client';

import type { ReactElement } from 'react';

interface LogoutConfirmationDialogProps {
  isOpen: boolean;
  isConfirming?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Hiển thị xác nhận rõ ràng trước khi người dùng chủ động kết thúc phiên đăng nhập. */
export default function LogoutConfirmationDialog({
  isOpen,
  isConfirming = false,
  onCancel,
  onConfirm,
}: LogoutConfirmationDialogProps): ReactElement | null {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        aria-label="Đóng xác nhận đăng xuất"
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
        disabled={isConfirming}
        onClick={onCancel}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="logout-confirmation-title"
        aria-describedby="logout-confirmation-description"
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-50 text-amber-700" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.75 9a2.25 2.25 0 1 1 3.55 1.84c-.8.57-1.3.96-1.3 2.16M12 16.5h.01" /></svg>
        </div>
        <h2 id="logout-confirmation-title" className="mt-4 text-lg font-bold text-slate-950">Xác nhận đăng xuất</h2>
        <p id="logout-confirmation-description" className="mt-2 text-sm leading-6 text-slate-600">
          Bạn có chắc chắn muốn đăng xuất? Phiên làm việc hiện tại sẽ kết thúc.
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={isConfirming}
            onClick={onCancel}
            className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Hủy
          </button>
          <button
            type="button"
            disabled={isConfirming}
            onClick={onConfirm}
            className="min-h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isConfirming ? 'Đang đăng xuất...' : 'Đăng xuất'}
          </button>
        </div>
      </section>
    </div>
  );
}
