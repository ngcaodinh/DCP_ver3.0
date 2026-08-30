'use client';

import type { ReactElement } from 'react';

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

type ToastIconName = 'check' | 'alert' | 'info';

interface ToastPresentation {
  iconName: ToastIconName;
  iconClassName: string;
}

/** Trả icon và màu nhất quán cho từng mức phản hồi của toast. */
function getToastPresentation(tone: ToastTone): ToastPresentation {
  if (tone === 'success') {
    return { iconName: 'check', iconClassName: 'bg-emerald-100 text-emerald-700' };
  }
  if (tone === 'error') {
    return { iconName: 'alert', iconClassName: 'bg-red-100 text-red-600' };
  }
  return { iconName: 'info', iconClassName: 'bg-cyan-100 text-cyan-700' };
}

/** Hiển thị icon SVG tương ứng với mức độ của toast mà không phụ thuộc glyph của font. */
function ToastIcon({ iconName }: { iconName: ToastIconName }): ReactElement {
  if (iconName === 'check') {
    return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>;
  }
  if (iconName === 'alert') {
    return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4M12 16h.01" /><circle cx="12" cy="12" r="9" /></svg>;
  }
  return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 10v6M12 7h.01" /></svg>;
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
        const { iconName, iconClassName } = getToastPresentation(toastItem.tone);
        return (
          <div
            key={toastItem.id}
            className="flex min-w-[280px] items-start gap-2 rounded-xl border border-emerald-900/15 bg-white p-3 shadow-lg"
          >
            <span
              className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${iconClassName}`}
              aria-hidden="true"
            >
              <ToastIcon iconName={iconName} />
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
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
