'use client';

import type { ReactNode } from 'react';

// =============================================================================
// Topbar cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/Topbar.tsx
// Mục đích: Header sticky với breadcrumb, notification bell, user info và nút đăng xuất
// =============================================================================

type TopbarProps = {
  breadcrumbTitle: string;
  userDisplayName: string;
  userEmail: string;
  userWalletAddress: string;
  onOpenMobileMenu?: () => void;
  notificationContent: ReactNode;
  onLogout: () => void;
};

/** Trả về chữ cái đầu tiên của tên hiển thị avatar. */
function getAvatarFallbackText(userDisplayName: string): string {
  const normalizedDisplayName = userDisplayName.trim();
  if (!normalizedDisplayName) return 'U';
  return normalizedDisplayName.charAt(0).toUpperCase();
}

export default function Topbar({
  breadcrumbTitle,
  userDisplayName,
  userEmail,
  userWalletAddress,
  onOpenMobileMenu,
  notificationContent,
  onLogout,
}: TopbarProps) {
  const avatarFallbackText = getAvatarFallbackText(userDisplayName);
  const shortWalletAddress = userWalletAddress.length > 15
    ? `${userWalletAddress.slice(0, 15)}...`
    : userWalletAddress;

  return (
    <header className="sticky inset-x-0 top-0 z-20 m-0 flex h-16 items-center justify-between border-b border-emerald-900/15 bg-white px-4 lg:px-7">
      {/* Left: hamburger (mobile) + breadcrumb */}
      <div className="flex items-center gap-2.5">
        {onOpenMobileMenu && (
          <button
            type="button"
            onClick={onOpenMobileMenu}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition hover:bg-slate-50 lg:hidden"
            aria-label="Mở menu điều hướng"
          >
            ☰
          </button>
        )}
        <p className="text-[12.5px] font-medium leading-none text-slate-500">
          <span>DCP</span>
          <span className="mx-1.5 inline-block text-slate-400">›</span>
          <span className="font-semibold text-slate-900">{breadcrumbTitle}</span>
        </p>
      </div>

      {/* Right: notification bell + user info + logout */}
      <div className="flex items-center gap-3.5">
        {notificationContent}

        <div className="hidden h-6 w-px bg-emerald-900/15 sm:block" />

        {/* User info + logout */}
        <div className="hidden items-center gap-2 sm:flex">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-300 text-[11px] font-bold text-slate-700">
            {avatarFallbackText}
          </div>
          <div className="min-w-0 max-w-[220px] leading-[1.15]">
            <p className="truncate text-[12px] font-semibold text-slate-900">{userDisplayName}</p>
            {userEmail && <p className="mt-0.5 truncate text-[10.5px] text-slate-500">{userEmail}</p>}
            {userWalletAddress && <p className="mt-0.5 truncate font-mono text-[10.5px] text-slate-500">{shortWalletAddress}</p>}
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="ml-1 inline-flex h-9 items-center gap-1.5 self-center rounded-lg border border-emerald-900/15 px-3 text-xs font-semibold text-slate-700 transition hover:bg-[#0E7C6B] hover:text-white"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
              <path d="M6 2h4v2H6zm0 10h4v2H6zM2 5h2v6H2zm10 0h2v6h-2zM5 4h6v1H5zm0 7h6v1H5z" />
            </svg>
            Đăng xuất
          </button>
        </div>
      </div>
    </header>
  );
}
