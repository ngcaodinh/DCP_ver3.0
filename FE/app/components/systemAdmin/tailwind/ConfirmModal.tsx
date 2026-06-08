// =============================================================================
// ConfirmModal cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/ConfirmModal.tsx
// Mục đích: Modal xác nhận hành động
// =============================================================================

type ConfirmModalProps = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDanger?: boolean;
};

export default function ConfirmModal({
  title,
  message,
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  onConfirm,
  onCancel,
  isDanger = false,
}: ConfirmModalProps) {
  // Không sử dụng PIN — chỉ xác nhận qua nút bấm
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-200/80 bg-white p-5 shadow-xl">
        {/* Icon */}
        <div className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full ${isDanger ? 'bg-red-100 text-red-600' : 'bg-[#0E7C6B]/10 text-[#0E7C6B]'}`}>
          {isDanger ? (
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          ) : (
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>

        {/* Title & Message */}
        <h3 id="confirm-modal-title" className="text-base font-bold text-slate-900">{title}</h3>
        <p className="mt-2 text-sm text-slate-600">{message}</p>

        {/* Actions */}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-xs font-bold text-white transition ${isDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-[#0E7C6B] hover:bg-[#0d6b5c]'
              }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
