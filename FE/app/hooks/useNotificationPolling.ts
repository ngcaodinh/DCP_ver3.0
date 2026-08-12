'use client';

import { useCallback, useEffect, useRef } from 'react';

const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

interface UseNotificationPollingOptions {
  refetchNotifications: () => Promise<unknown>;
  enabled: boolean;
}

/** Chạy REST revalidation không chồng request để fallback vẫn bounded khi polling và focus cùng xảy ra. */
function useBoundedNotificationRefetch(refetchNotifications: () => Promise<unknown>, enabled: boolean): () => void {
  const refetchNotificationsRef = useRef(refetchNotifications);
  const enabledRef = useRef(enabled);
  const isRefetchingRef = useRef(false);

  useEffect(() => {
    refetchNotificationsRef.current = refetchNotifications;
    enabledRef.current = enabled;
  }, [enabled, refetchNotifications]);

  return useCallback(() => {
    if (!enabledRef.current || isRefetchingRef.current || document.hidden) {
      return;
    }

    isRefetchingRef.current = true;
    try {
      // Bắt lỗi tại fallback để promise bị từ chối không tạo unhandled rejection ngoài luồng Query.
      void refetchNotificationsRef.current()
        .catch(() => undefined)
        .finally(() => {
          isRefetchingRef.current = false;
        });
    } catch (_error: unknown) {
      // Giải phóng khóa ngay cả khi seam refetch ném lỗi đồng bộ ngoài hợp đồng Promise.
      isRefetchingRef.current = false;
    }
  }, []);
}

/**
 * Duy trì REST polling visible-only cho notification khi backend chưa công bố Socket.IO event contract.
 */
export function useNotificationPolling({ refetchNotifications, enabled }: UseNotificationPollingOptions): () => void {
  const requestRefetch = useBoundedNotificationRefetch(refetchNotifications, enabled);

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    /** Bật duy nhất một polling timer khi tab đang nhìn thấy. */
    const startPolling = (): void => {
      if (document.hidden || pollTimer) {
        return;
      }
      pollTimer = setInterval(requestRefetch, NOTIFICATION_POLL_INTERVAL_MS);
    };

    /** Dừng polling khi tab bị ẩn để không tiêu tốn tài nguyên ngoài màn hình. */
    const stopPolling = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    /** Khôi phục polling và đồng bộ ngay một lần khi người dùng quay lại tab. */
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        stopPolling();
        return;
      }
      requestRefetch();
      startPolling();
    };

    /** Revalidate khi cửa sổ lấy lại focus để giảm độ trễ trong REST-only mode. */
    const handleWindowFocus = (): void => {
      requestRefetch();
    };

    if (!enabled) {
      return () => undefined;
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [enabled, requestRefetch]);

  return requestRefetch;
}
