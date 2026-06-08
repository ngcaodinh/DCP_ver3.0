type ConfirmModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/** Hàm component ConfirmModal để xác nhận hành động ký duyệt trước khi thực thi. */
export default function ConfirmModal({ isOpen, onClose, onConfirm }: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-[2px]" onClick={onClose} aria-label="Đóng modal" />
      <div className="fixed left-1/2 top-1/2 z-[61] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-emerald-900/15 px-6 py-4"><h3 className="text-base font-bold text-slate-900">Xác nhận ký duyệt giao dịch</h3></div>
        <div className="space-y-2 px-6 py-4 text-sm text-slate-600">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">Bước 1: Kiểm tra đủ chứng từ</div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">Bước 2: Xác thực PIN thiết bị ký số</div>
          <input className="mt-1 w-full rounded-lg border-2 border-emerald-900/15 px-3 py-2 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-cyan-500" placeholder="••••••" />
        </div>
        <div className="flex gap-2 border-t border-emerald-900/15 px-6 py-4">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-emerald-900/15 py-2 text-sm font-semibold text-slate-700">Hủy</button>
          <button type="button" onClick={onConfirm} className="flex-[2] rounded-lg bg-emerald-600 py-2 text-sm font-bold text-white">Xác nhận</button>
        </div>
      </div>
    </>
  );
}

