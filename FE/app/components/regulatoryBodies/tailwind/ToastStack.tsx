import type { ToastItem } from './types';

type ToastStackProps = {
  toastItemList: ToastItem[];
  onCloseToast: (toastId: string) => void;
};

/** Hàm component ToastStack để hiển thị phản hồi tức thời khi thao tác ký duyệt hoặc từ chối. */
export default function ToastStack({ toastItemList, onCloseToast }: ToastStackProps) {
  return (
    <div className="fixed right-4 top-4 z-[70] space-y-2">
      {toastItemList.map(toastItem => (
        <div key={toastItem.id} className="flex min-w-[280px] items-start gap-2 rounded-xl border border-emerald-900/15 bg-white p-3 shadow-lg">
          <span className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${toastItem.tone === 'success' ? 'bg-emerald-100 text-emerald-700' : toastItem.tone === 'error' ? 'bg-red-100 text-red-600' : 'bg-cyan-100 text-cyan-700'}`}>{toastItem.tone === 'success' ? '✓' : toastItem.tone === 'error' ? '!' : 'i'}</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-900">{toastItem.titleText}</p>
            <p className="text-xs text-slate-600">{toastItem.bodyText}</p>
          </div>
          <button type="button" onClick={() => onCloseToast(toastItem.id)} className="text-sm text-slate-500">✕</button>
        </div>
      ))}
    </div>
  );
}

