'use client';

import type { ReactNode } from 'react';

type TopbarProps = {
  breadcrumbTitle: string;
  userDisplayName: string;
  userEmail: string;
  userWalletAddress: string;
  onOpenMobileMenu?: () => void;
  notificationContent: ReactNode;
  onLogout: () => void;
};

const WALLET_ADDRESS_PREFIX_LENGTH = 8;
const WALLET_ADDRESS_SUFFIX_LENGTH = 4;
const WALLET_ALIAS_DOMAIN = '@wallet.dcp.local';

/** Lấy chữ cái đầu từ tên hiển thị để dùng làm avatar dự phòng. */
function getAvatarFallbackText(userDisplayName: string): string {
  const normalizedDisplayName = userDisplayName.trim();
  if (!normalizedDisplayName) return 'U';
  return normalizedDisplayName.charAt(0).toUpperCase();
}

/** Rút gọn địa chỉ ví, giữ 6 ký tự đầu sau 0x và 4 ký tự cuối để đối chiếu nhanh. */
function getShortWalletAddress(userWalletAddress: string): string {
  const normalizedWalletAddress = userWalletAddress.trim();
  if (normalizedWalletAddress.length <= WALLET_ADDRESS_PREFIX_LENGTH + WALLET_ADDRESS_SUFFIX_LENGTH) return normalizedWalletAddress;
  return `${normalizedWalletAddress.slice(0, WALLET_ADDRESS_PREFIX_LENGTH)}...${normalizedWalletAddress.slice(-WALLET_ADDRESS_SUFFIX_LENGTH)}`;
}

/** Rút gọn địa chỉ ví được ghép trong tên hiển thị để header không bị tràn trên màn hình hẹp. */
function getCompactDisplayName(userDisplayName: string): string {
  return userDisplayName.trim().replace(/0x[a-fA-F0-9]{40}/g, getShortWalletAddress);
}

/** Loại email định danh tự sinh trùng với ví, giữ một dòng ví duy nhất để tránh lặp thông tin. */
function getUserContactInfo(userEmail: string, userWalletAddress: string): { emailText: string; walletText: string } {
  const normalizedEmail = userEmail.trim();
  const normalizedWalletAddress = userWalletAddress.trim();
  const isWalletAlias = normalizedEmail.toLowerCase() === `${normalizedWalletAddress.toLowerCase()}${WALLET_ALIAS_DOMAIN}`;

  return {
    emailText: isWalletAlias ? '' : normalizedEmail,
    walletText: normalizedWalletAddress ? getShortWalletAddress(normalizedWalletAddress) : '',
  };
}

/** Hiển thị breadcrumb, nhận diện tài khoản đã rút gọn và thao tác chung của khu vực Admin. */
export default function Topbar({
  breadcrumbTitle,
  userDisplayName,
  userEmail,
  userWalletAddress,
  onOpenMobileMenu,
  notificationContent,
  onLogout,
}: TopbarProps) {
  const compactDisplayName = getCompactDisplayName(userDisplayName);
  const avatarFallbackText = getAvatarFallbackText(compactDisplayName);
  const { emailText, walletText } = getUserContactInfo(userEmail, userWalletAddress);

  return (
    <header className="sticky inset-x-0 top-0 z-20 m-0 flex h-16 items-center justify-between border-b border-emerald-900/15 bg-white px-4 lg:z-10 lg:px-7">
      <div className="min-w-0 flex items-center gap-2.5">
        {onOpenMobileMenu ? (
          <button
            type="button"
            onClick={onOpenMobileMenu}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition hover:bg-slate-50 lg:hidden"
            aria-label="Mở menu điều hướng"
          >
            ☰
          </button>
        ) : null}
        <p className="max-w-[calc(100vw-136px)] truncate text-[12.5px] font-medium leading-none text-slate-500 sm:max-w-none">
          <span>DCP</span>
          <span className="mx-1.5 inline-block text-slate-400">›</span>
          <span className="font-semibold text-slate-900">{breadcrumbTitle}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3.5">
        {notificationContent}
        <div className="hidden h-6 w-px bg-emerald-900/15 sm:block" />
        <div className="hidden items-center gap-2 sm:flex">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-300 text-[11px] font-bold text-slate-700">
            {avatarFallbackText}
          </div>
          <div className="min-w-0 max-w-[220px] leading-[1.15]">
            <p className="truncate text-[12px] font-semibold text-slate-900" title={userDisplayName}>{compactDisplayName}</p>
            {emailText ? <p className="mt-0.5 truncate text-[10.5px] text-slate-500" title={emailText}>{emailText}</p> : null}
            {walletText ? <p className="mt-0.5 truncate font-mono text-[10.5px] text-slate-500" title={userWalletAddress}>{walletText}</p> : null}
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="ml-1 inline-flex h-9 items-center gap-1.5 self-center rounded-lg border border-emerald-900/15 px-3 text-xs font-semibold text-slate-700 transition hover:bg-[#0E7C6B] hover:text-white"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
              <path d="M6 2h4v2H6zm0 10h4v2H6zm-4-7h2v6H2zm10 0h2v6h-2zM5 4h6v1H5zm0 7h6v1H5z" />
            </svg>
            Đăng xuất
          </button>
        </div>
      </div>
    </header>
  );
}
