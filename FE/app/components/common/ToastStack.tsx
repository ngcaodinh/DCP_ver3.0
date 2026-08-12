'use client';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  titleText: string;
  bodyText: string;
  tone: ToastTone;
}

interface ToastStackProps {
  toastItemList: readonly ToastItem[];
  onCloseToast: (toastId: string) => void;
}

interface ToastPresentation {
  icon: string;
  iconClassName: string;
}

/** Trả icon và màu nhất quán cho từng mức phản hồi của toast. */
function getToastPresentation(tone: ToastTone): ToastPresentation {
  if (tone === 'success') {
    return { icon: '✓', iconClassName: 'bg-emerald-100 text-emerald-700' };
  }
  if (tone === 'error') {
    return { icon: '!', iconClassName: 'bg-red-100 text-red-600' };
  }
  return { icon: 'i', iconClassName: 'bg-cyan-100 text-cyan-700' };
}

/** Hiển thị stack toast dùng chung cho các dashboard và settings của ứng dụng. */
export default function ToastStack({ toastItemList, onCloseToast }: ToastStackProps): React.ReactElement {
  return (
    <div
      className="fixed right-4 top-4 z-[70] space-y-2"
      role="region"
      aria-label="Thông báo"
      aria-live="polite"
    >
      {toastItemList.map((toastItem) => {
        const { icon, iconClassName } = getToastPresentation(toastItem.tone);
        return (
          <div
            key={toastItem.id}
            className="flex min-w-[280px] items-start gap-2 rounded-xl border border-emerald-900/15 bg-white p-3 shadow-lg"
          >
            <span
              className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${iconClassName}`}
              aria-hidden="true"
            >
              {icon}
            </span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">{toastItem.titleText}</p>
              <p className="text-xs text-slate-600">{toastItem.bodyText}</p>
            </div>
            <button
              type="button"
              onClick={() => onCloseToast(toastItem.id)}
              className="text-sm text-slate-500"
              aria-label="Đóng thông báo"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
