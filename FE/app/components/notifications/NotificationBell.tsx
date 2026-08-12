'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMarkNotificationAsRead, useNotifications } from '@/app/hooks/useNotifications';
import { useNotificationPolling } from '@/app/hooks/useNotificationPolling';
import { getNotificationAccessibleLabel, getNotificationIcon, formatNotificationTimestamp } from './notificationPresentation';
import { getNotificationNavigationPath } from './notificationNavigation';
import type { NotificationItem } from './types';

const NOTIFICATION_BADGE_MAXIMUM = 9;

/** Chuẩn hóa unread count để aria-label và badge không hiển thị số âm hoặc NaN. */
function getSafeUnreadCount(unreadCount: number | undefined): number {
  return Number.isFinite(unreadCount) ? Math.max(0, unreadCount as number) : 0;
}

/** Định dạng badge theo quy ước topbar đang dùng, nhưng aria-label vẫn chứa số thực tế. */
function formatNotificationBadge(unreadCount: number): string {
  return unreadCount > NOTIFICATION_BADGE_MAXIMUM ? `${NOTIFICATION_BADGE_MAXIMUM}+` : String(unreadCount);
}

/** Phân biệt lỗi xác thực/quyền với lỗi tải chung mà không hiển thị payload API thô cho người dùng. */
function getNotificationErrorText(error: unknown): string {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
  if (statusCode === 401) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }
  if (statusCode === 403) {
    return 'Bạn không có quyền xem thông báo.';
  }
  return 'Không thể tải thông báo. Vui lòng thử lại.';
}

/** Chuẩn hóa lỗi mark-read thành thông báo an toàn để người dùng biết có thể thử lại. */
function getMarkNotificationErrorText(error: unknown): string {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
  if (statusCode === 401) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }
  if (statusCode === 403) {
    return 'Bạn không có quyền cập nhật thông báo này.';
  }
  if (statusCode === 404) {
    return 'Thông báo đã được cập nhật ở nơi khác. Vui lòng thử lại.';
  }
  return 'Không thể đánh dấu thông báo đã đọc. Vui lòng thử lại.';
}

/** Bell dùng chung cho các topbar xác thực, hỗ trợ keyboard, cache revalidation và REST-only fallback. */
export default function NotificationBell(): React.ReactElement {
  const router = useRouter();
  const panelId = useId();
  const rootElementRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [markReadErrorMessage, setMarkReadErrorMessage] = useState<string | null>(null);
  const notificationsQuery = useNotifications();
  const markAsReadMutation = useMarkNotificationAsRead();
  const unreadCount = getSafeUnreadCount(notificationsQuery.data?.unreadCount);

  const requestRefetch = useNotificationPolling({
    refetchNotifications: notificationsQuery.refetch,
    enabled: notificationsQuery.isEnabled
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    /** Đóng dropdown khi click/touch nằm ngoài vùng chuông và panel. */
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootElementRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    /** Escape chỉ đóng panel hiện tại và để trình duyệt duy trì focus tự nhiên trên trigger. */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  /** Mở/đóng panel và revalidate ngay ở lần mở để dữ liệu không chờ chu kỳ 30 giây. */
  const handleTogglePanel = (): void => {
    const nextOpenState = !isOpen;
    setMarkReadErrorMessage(null);
    setIsOpen(nextOpenState);
    if (nextOpenState) {
      requestRefetch();
    }
  };

  /** Mark unread item trước, rồi chỉ điều hướng qua whitelist khi contract BE/PO đã được chốt. */
  const handleNotificationClick = async (notification: NotificationItem): Promise<void> => {
    setMarkReadErrorMessage(null);
    if (!notification.isRead) {
      try {
        await markAsReadMutation.mutateAsync(notification.notificationId);
      } catch (error: unknown) {
        setMarkReadErrorMessage(getMarkNotificationErrorText(error));
        return;
      }
    }

    const navigationPath = getNotificationNavigationPath(notification.metadata);
    if (navigationPath) {
      router.push(navigationPath);
    }
    setIsOpen(false);
  };

  return (
    <div ref={rootElementRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTogglePanel}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#0E7C6B] focus:ring-offset-2"
        aria-label={`${unreadCount} thông báo chưa đọc`}
        aria-expanded={isOpen}
        aria-controls={panelId}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
          <path d="M8 2a5 5 0 00-5 5v1L2 10v1h12v-1l-1-2V7a5 5 0 00-5-5zm0 13a2 2 0 002-2H6a2 2 0 002 2z" />
        </svg>
        {unreadCount > 0 ? (
          <span
            className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-red-600 px-1 text-[9px] font-bold text-white"
            aria-hidden="true"
          >
            {formatNotificationBadge(unreadCount)}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <section
          id={panelId}
          aria-label="Danh sách thông báo"
          className="absolute right-0 top-11 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[#D1FAE5] bg-white shadow-2xl"
        >
          <header className="border-b border-[#D1FAE5] bg-[#F8FFFD] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#064E3B]">Thông báo</h2>
          </header>

          <div className="max-h-[min(26rem,calc(100vh-9rem))] overflow-y-auto">
            {markReadErrorMessage ? (
              <p className="border-b border-red-100 bg-red-50 p-3 text-sm text-red-700" role="alert">
                {markReadErrorMessage}
              </p>
            ) : null}

            {!notificationsQuery.isEnabled ? (
              <p className="p-4 text-sm text-amber-700" role="alert">Bạn cần đăng nhập để xem thông báo.</p>
            ) : null}

            {notificationsQuery.isEnabled && notificationsQuery.isPending ? (
              <p className="p-4 text-sm text-slate-500" role="status">Đang tải thông báo...</p>
            ) : null}

            {notificationsQuery.isEnabled && notificationsQuery.isError ? (
              <div className="space-y-3 p-4" role="alert">
                <p className="text-sm text-red-700">{getNotificationErrorText(notificationsQuery.error)}</p>
                <button
                  type="button"
                  onClick={requestRefetch}
                  className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  Thử lại
                </button>
              </div>
            ) : null}

            {notificationsQuery.isEnabled && !notificationsQuery.isPending && !notificationsQuery.isError && notificationsQuery.data?.notifications.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Không có thông báo nào</p>
            ) : null}

            {notificationsQuery.isEnabled && !notificationsQuery.isPending && !notificationsQuery.isError && notificationsQuery.data?.notifications.length ? (
              <ul className="divide-y divide-slate-100" aria-label="Các thông báo">
                {notificationsQuery.data.notifications.map((notification) => (
                  <li key={notification.notificationId}>
                    <button
                      type="button"
                      onClick={() => void handleNotificationClick(notification)}
                      disabled={markAsReadMutation.isPending && markAsReadMutation.variables === notification.notificationId}
                      className={`flex w-full gap-3 px-4 py-3 text-left transition hover:bg-[#F8FFFD] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#0E7C6B] disabled:cursor-wait ${notification.isRead ? 'bg-white' : 'bg-[#F2FBFA]'}`}
                      aria-label={getNotificationAccessibleLabel(notification)}
                    >
                      <span className="mt-0.5 text-lg" aria-hidden="true">{getNotificationIcon(notification.notificationType)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{notification.title}</span>
                        <span className="mt-0.5 block text-sm text-slate-700">{notification.content}</span>
                        <span className="mt-1 block text-xs text-slate-500">{formatNotificationTimestamp(notification.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
