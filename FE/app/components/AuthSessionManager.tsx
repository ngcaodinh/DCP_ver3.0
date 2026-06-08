'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  authenticationSessionUpdatedEventName,
  clearAuthSession,
  persistAuthSession,
  readAuthSession
} from '../utils/authSession';

type RefreshResponse = {
  accessToken?: string;
  refreshToken?: string;
  csrfToken?: string;
  refreshSessionId?: string;
  expiresAt?: string;
};

const minimumRefreshDelayMs = 15 * 1000;

// Ghi chú: Quản lý auto refresh token theo hạn phiên nhận từ backend.
export default function AuthSessionManager() {
  const refreshTimerRef = useRef<number | null>(null);

  const backendBaseUrl = useMemo(
    () => process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000',
    []
  );

  // Ghi chú: Xóa timer refresh đang chạy để tránh đụng lịch.
  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Ghi chú: Tính thời điểm refresh tiếp theo dựa trên expiresAt từ backend.
  const calculateNextRefreshDelay = useCallback((): number | null => {
    const { refreshTokenExpiresAt } = readAuthSession();
    if (!refreshTokenExpiresAt) {
      return null;
    }

    const expirationTime = new Date(refreshTokenExpiresAt).getTime();
    if (Number.isNaN(expirationTime)) {
      return null;
    }

    const refreshOffsetMs = 60 * 1000;
    const delayMs = expirationTime - Date.now() - refreshOffsetMs;
    return Math.max(delayMs, minimumRefreshDelayMs);
  }, []);

  // Ghi chú: Gọi API refresh token và đồng bộ lại localStorage.
  const executeTokenRefresh = useCallback(async () => {
    const { refreshToken, refreshSessionId, csrfToken } = readAuthSession();
    if (!refreshToken || !refreshSessionId || !csrfToken) {
      clearAuthSession();
      clearRefreshTimer();
      return;
    }

    try {
      const response = await fetch(`${backendBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ refreshToken, refreshSessionId })
      });
      const responseData: RefreshResponse = await response.json();

      // Ghi chú logic phức tạp: nếu refresh thất bại phải hủy phiên để tránh token stale.
      if (!response.ok) {
        throw new Error(responseData?.accessToken ? '' : 'Refresh token thất bại.');
      }

      persistAuthSession({
        accessToken: responseData.accessToken,
        refreshToken: responseData.refreshToken,
        csrfToken: responseData.csrfToken,
        refreshSessionId: responseData.refreshSessionId,
        refreshTokenExpiresAt: responseData.expiresAt
      });
    } catch (error) {
      clearAuthSession();
    }
  }, [backendBaseUrl, clearRefreshTimer]);

  // Ghi chú: Lập lịch refresh token tiếp theo dựa trên expiresAt.
  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();
    const delayMs = calculateNextRefreshDelay();
    if (delayMs === null) {
      return;
    }

    refreshTimerRef.current = window.setTimeout(async () => {
      await executeTokenRefresh();
      scheduleRefresh();
    }, delayMs);
  }, [calculateNextRefreshDelay, clearRefreshTimer, executeTokenRefresh]);

  useEffect(() => {
    scheduleRefresh();

    const handleAuthSessionUpdated = () => {
      scheduleRefresh();
    };

    window.addEventListener(authenticationSessionUpdatedEventName, handleAuthSessionUpdated);

    return () => {
      clearRefreshTimer();
      window.removeEventListener(authenticationSessionUpdatedEventName, handleAuthSessionUpdated);
    };
  }, [clearRefreshTimer, scheduleRefresh]);

  return null;
}

