type TopbarProps = {
  breadcrumbTitle: string;
  userDisplayName: string;
  userEmail: string;
  userWalletAddress: string;
  notificationCount?: number;
  onOpenMobileMenu: () => void;
  onOpenNotification: () => void;
  onLogout: () => void;
};

/** Hàm lấy chữ cái đầu từ tên người dùng để hiển thị avatar mặc định. */
function getAvatarFallbackText(userDisplayName: string): string {
  const normalizedDisplayName = userDisplayName.trim();
  if (!normalizedDisplayName) {
    return 'U';
  }

  return normalizedDisplayName.charAt(0).toUpperCase();
}

/** Hàm rút gọn địa chỉ ví theo yêu cầu chỉ hiển thị 3 ký tự đầu, phần còn lại thay bằng dấu ba chấm. */
function getShortWalletAddress(userWalletAddress: string): string {
  const normalizedWalletAddress = userWalletAddress.trim();
  if (normalizedWalletAddress.length <= 15) {
    return normalizedWalletAddress;
  }

  const walletAddressStartSegment = normalizedWalletAddress.slice(0, 15);
  return `${walletAddressStartSegment}...`;
}

/** Hàm tổng hợp email và địa chỉ ví để hiển thị theo từng dòng tách biệt. */
function getUserContactInfo(userEmail: string, userWalletAddress: string): { emailText: string; walletText: string } {
  const normalizedUserEmail = userEmail.trim();
  const normalizedWalletAddress = userWalletAddress.trim();
  const shortWalletAddress = normalizedWalletAddress ? getShortWalletAddress(normalizedWalletAddress) : '';

  // Ghi chú logic: Ưu tiên giữ email ở dòng đầu, ví (nếu có) xuống dòng riêng để dễ đọc khi Gmail dài.
  return {
    emailText: normalizedUserEmail,
    walletText: shortWalletAddress
  };
}

/** Hàm component Topbar để hiển thị breadcrumb, thao tác nhanh và thông tin người dùng đăng nhập. */
export default function Topbar({
  breadcrumbTitle,
  userDisplayName,
  userEmail,
  userWalletAddress,
  notificationCount = 0,
  onOpenMobileMenu,
  onOpenNotification,
  onLogout
}: TopbarProps) {
  const avatarFallbackText = getAvatarFallbackText(userDisplayName);
  const { emailText, walletText } = getUserContactInfo(userEmail, userWalletAddress);
  const hasUnreadNotification = notificationCount > 0;

  return (
    <header className="sticky inset-x-0 top-0 z-20 m-0 flex h-16 items-center justify-between border-b border-emerald-900/15 bg-white px-4 lg:z-10 lg:px-7">
      <div className="min-w-0 flex items-center gap-2.5">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition hover:bg-slate-50 lg:hidden"
          aria-label="Mở menu điều hướng"
        >
          ☰
        </button>
        <p className="max-w-[calc(100vw-136px)] truncate text-[12.5px] font-medium leading-none text-slate-500 sm:max-w-none">
          <span>DCP</span>
          <span className="mx-1.5 inline-block text-slate-400">›</span>
          <span className="font-semibold text-slate-900">{breadcrumbTitle}</span>
        </p>
      </div>

      <div className="shrink-0 flex items-center gap-3.5">
        <button
          type="button"
          onClick={onOpenNotification}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition hover:bg-slate-50"
          aria-label="Mở thông báo"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <path d="M8 2a5 5 0 00-5 5v1L2 10v1h12v-1l-1-2V7a5 5 0 00-5-5zm0 13a2 2 0 002-2H6a2 2 0 002 2z" />
          </svg>
          {hasUnreadNotification ? (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-red-600 px-1 text-[9px] font-bold text-white">
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          ) : null}
        </button>

        <div className="hidden h-6 w-px bg-emerald-900/15 sm:block" />

        <div className="hidden items-center gap-2 sm:flex">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-300 text-[11px] font-bold text-slate-700">{avatarFallbackText}</div>
          <div className="min-w-0 max-w-[220px] leading-[1.15]">
            <p className="truncate text-[12px] font-semibold text-slate-900">{userDisplayName}</p>
            {emailText ? <p className="mt-0.5 truncate text-[10.5px] text-slate-500">{emailText}</p> : null}
            {walletText ? <p className="mt-0.5 truncate text-[10.5px] text-slate-500">{walletText}</p> : null}
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
