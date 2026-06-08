'use client';

// =============================================================================
// ToastStack cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/ToastStack.tsx
// Mục đích: Stack thông báo toast hiển thị ở góc phải trên cùng với icon và tiêu đề
// =============================================================================

import type { ToastItem } from './types';

/** Hàm trả về icon và màu nền theo tone của toast. */
function getToastIcon(tone: ToastItem['tone']) {
  if (tone === 'success') return { icon: '✓', bgClass: 'bg-emerald-100 text-emerald-700' };
  if (tone === 'error') return { icon: '!', bgClass: 'bg-red-100 text-red-600' };
  return { icon: 'i', bgClass: 'bg-cyan-100 text-cyan-700' };
}

type ToastStackProps = {
  toastItemList: ToastItem[];
  onCloseToast: (toastId: string) => void;
};

export default function ToastStack({ toastItemList, onCloseToast }: ToastStackProps) {
  return (
    <div
      className="fixed right-4 top-4 z-[70] space-y-2"
      role="region"
      aria-label="Thông báo"
      aria-live="polite"
    >
      {toastItemList.map((toastItem) => {
        const { icon, bgClass } = getToastIcon(toastItem.tone);
        return (
          <div
            key={toastItem.id}
            className="flex min-w-[280px] items-start gap-2 rounded-xl border border-emerald-900/15 bg-white p-3 shadow-lg"
          >
            {/* Icon */}
            <span className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${bgClass}`}>
              {icon}
            </span>
            {/* Content */}
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">{toastItem.titleText}</p>
              <p className="text-xs text-slate-600">{toastItem.bodyText}</p>
            </div>
            {/* Close button */}
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
