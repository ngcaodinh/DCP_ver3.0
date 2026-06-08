import { ReactNode } from 'react';

type SectionCardProps = {
  title: string;
  actionText?: string;
  rightSlot?: ReactNode;
  bodyClassName?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Hàm component khung card chuẩn.
 * Mục đích: tái sử dụng layout header/body đồng nhất cho nhiều khu vực.
 */
export function SectionCard({ title, actionText, rightSlot, bodyClassName, className, children }: SectionCardProps) {
  return (
    <div className={`overflow-hidden rounded-[14px] border border-[#E5E7EB] bg-white shadow-[0_1px_3px_rgba(0,0,0,.07),0_1px_2px_rgba(0,0,0,.05)] ${className ?? ''}`}>
      <div className="flex items-center justify-between border-b border-[#F3F4F6] px-5 pb-[14px] pt-[18px]">
        <h3 className="font-['Be_Vietnam_Pro'] text-[15px] font-semibold text-[#0D1117]">{title}</h3>
        {rightSlot ?? (actionText ? <span className="cursor-pointer text-xs font-medium text-[#0E7C6B]">{actionText}</span> : null)}
      </div>
      <div className={bodyClassName ?? 'p-5'}>{children}</div>
    </div>
  );
}

type ProgressBarProps = {
  progressPercent: number;
  className?: string;
  fillClassName?: string;
};

/**
 * Hàm component thanh tiến độ.
 * Mục đích: gom logic hiển thị phần trăm vào một component dễ tái dùng.
 */
export function ProgressBar({ progressPercent, className, fillClassName }: ProgressBarProps) {
  return (
    <div className={className ?? 'h-[7px] overflow-hidden rounded bg-[#F3F4F6]'}>
      <div
        className={fillClassName ?? 'h-full rounded bg-gradient-to-r from-[#0E7C6B] to-[#0A5C50]'}
        style={{ width: `${progressPercent}%` }}
      />
    </div>
  );
}

type BadgeProps = {
  label: string;
  className: string; 
};

/**
 * Hàm component badge văn bản.
 * Mục đích: chuẩn hóa phần huy hiệu trạng thái ở nhiều bảng/card.
 */
export function StatusBadge({ label, className }: BadgeProps) {
  return <span className={`inline-flex rounded-[20px] px-2 py-[3px] text-[11px] font-medium ${className}`}>{label}</span>;
}

type IconButtonProps = {
  label: string;
  hasDot?: boolean;
};

/**
 * Hàm component nút icon ở topbar.
 * Mục đích: giữ đồng bộ style và giảm lặp class trong phần header.
 */
export function TopbarIconButton({ label, hasDot }: IconButtonProps) {
  return (
    <button
      type="button"
      className="relative flex h-9 w-9 items-center justify-center rounded-[9px] border border-[#E5E7EB] bg-[#F3F4F6] text-[15px] transition hover:bg-[#E5E7EB]"
    >
      {label}
      {hasDot ? <span className="absolute right-[6px] top-[6px] h-[7px] w-[7px] rounded-full border border-white bg-[#E11D48]" /> : null}
    </button>
  );
}
