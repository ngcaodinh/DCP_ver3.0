/**
 * GuestWalletBanner — Persistent banner hiển thị sau khi guest donation thành công.
 * Mục đích: nhắc nhở người dùng lưu ví guest bằng cách claim vào tài khoản.
 * Banner chỉ hiển thị khi: session active, user chưa claim, user chưa login, prompt chưa bị dismiss.
 */
'use client';

import { useGuestWallet } from '@/app/components/GuestWalletProvider';
import { WalletAlertIcon } from '@/app/components/common/WalletAlertIcon';

interface GuestWalletBannerProps {
  /** Callback khi user click "Lưu ví ngay" — trigger Google OAuth flow */
  onClaimClick: () => void;
}

/**
 * Banner khuyến khích user đăng nhập và claim guest wallet.
 * Mục đích: chuyển đổi guest user thành registered user sau khi donate thành công.
 */
export function GuestWalletBanner({ onClaimClick }: GuestWalletBannerProps) {
  const { initState, dismissClaimPrompt } = useGuestWallet();

  // Chỉ hiển thị khi: session active + user chưa claim + prompt chưa dismiss + đã donate ít nhất 1 lần
  if (initState.initStatus !== 'READY') return null;
  if (initState.claimPromptDismissed) return null;
  if (initState.donationCount === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-amber-200 bg-amber-50 shadow-lg">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <WalletAlertIcon className="h-5 w-5 shrink-0 text-amber-600" />
            <span className="text-sm font-semibold text-amber-900">
              Lưu ví để không mất lịch sử quyên góp
            </span>
          </div>
          <p className="text-xs leading-relaxed text-amber-700 sm:text-sm">
            Bạn đã quyên góp <span className="font-semibold">{initState.donationCount} lần</span> từ ví tạm thời.
            Đăng nhập ngay để lưu ví và xem lịch sử quyên góp.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={dismissClaimPrompt}
            className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
          >
            Để sau
          </button>
          <button
            type="button"
            onClick={onClaimClick}
            className="rounded-md bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-amber-600"
          >
            Lưu ví ngay
          </button>
        </div>
      </div>
    </div>
  );
}
