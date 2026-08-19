'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  authenticationSessionUpdatedEventName,
  readAuthSession
} from '../utils/authSession';
import { refreshAuthSession } from '../utils/authSessionRefresh';

const refreshBeforeAccessTokenExpiresMs = 60 * 1000;
const transientRefreshRetryDelayMs = 60 * 1000;

/** Đọc hạn access token từ payload JWT để lên lịch refresh mà không phụ thuộc export động của module phiên. */
function getAccessTokenExpirationTime(accessToken: string): number | null {
  if (typeof window === 'undefined') return null;
  const payloadSegment = accessToken.split('.')[1];
  if (!payloadSegment) return null;

  try {
    const normalizedPayloadSegment = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const base64Padding = '='.repeat((4 - (normalizedPayloadSegment.length % 4)) % 4);
    const parsedPayload = JSON.parse(window.atob(`${normalizedPayloadSegment}${base64Padding}`)) as { exp?: unknown };
    return typeof parsedPayload.exp === 'number' && Number.isFinite(parsedPayload.exp)
      ? parsedPayload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

// Ghi chú: Quản lý auto refresh token theo hạn phiên nhận từ backend.
export default function AuthSessionManager() {
  const refreshTimerRef = useRef<number | null>(null);

  // Ghi chú: Xóa timer refresh đang chạy để tránh đụng lịch.
  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Ghi chú: Tính thời điểm refresh theo hạn access token, không dùng hạn refresh token 30 ngày.
  const calculateNextRefreshDelay = useCallback((): number | null => {
    const { accessToken } = readAuthSession();
    const accessTokenExpirationTime = getAccessTokenExpirationTime(accessToken || '');
    if (accessTokenExpirationTime === null) {
      return null;
    }

    return Math.max(accessTokenExpirationTime - Date.now() - refreshBeforeAccessTokenExpiresMs, 0);
  }, []);

  // Ghi chú: Lỗi mạng hoặc 429 chỉ lên lịch thử lại, không tự đăng xuất người dùng.
  const scheduleRefresh = useCallback((delayOverrideMs?: number) => {
    clearRefreshTimer();
    const delayMs = delayOverrideMs ?? calculateNextRefreshDelay();
    if (delayMs === null) {
      return;
    }

    refreshTimerRef.current = window.setTimeout(async () => {
      const refreshResult = await refreshAuthSession();
      if (refreshResult.status === 'RATE_LIMITED' || refreshResult.status === 'UNAVAILABLE') {
        scheduleRefresh(transientRefreshRetryDelayMs);
        return;
      }

      scheduleRefresh();
    }, delayMs);
  }, [calculateNextRefreshDelay, clearRefreshTimer]);

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
