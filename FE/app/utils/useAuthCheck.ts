'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Hàm đọc auth state từ localStorage an toàn cho SSR.
 * Mục đích: kiểm tra browser environment trước khi truy cập window.localStorage
 * để tránh lỗi "window is not defined" trong Next.js SSR context.
 */
const getInitialSessionData = () => {
  if (typeof window === 'undefined') {
    return {
      accessToken: '',
      refreshToken: '',
      csrfToken: '',
      refreshSessionId: '',
      refreshTokenExpiresAt: '',
      userFullName: '',
      userEmail: '',
      userWalletAddress: '',
      userId: '',
      userRole: ''
    };
  }

  const accessTokenStorageKey = 'dcpAccessToken';
  const refreshTokenStorageKey = 'dcpRefreshToken';
  const csrfTokenStorageKey = 'dcpCsrfToken';
  const refreshSessionStorageKey = 'dcpRefreshSessionId';
  const refreshTokenExpiresAtStorageKey = 'dcpRefreshTokenExpiresAt';
  const userFullNameStorageKey = 'dcpUserFullName';
  const userEmailStorageKey = 'dcpUserEmail';
  const userWalletAddressStorageKey = 'dcpUserWalletAddress';
  const userIdStorageKey = 'dcpUserId';
  const userRoleStorageKey = 'dcpUserRole';

  return {
    accessToken: window.localStorage.getItem(accessTokenStorageKey) || '',
    refreshToken: window.localStorage.getItem(refreshTokenStorageKey) || '',
    csrfToken: window.localStorage.getItem(csrfTokenStorageKey) || '',
    refreshSessionId: window.localStorage.getItem(refreshSessionStorageKey) || '',
    refreshTokenExpiresAt: window.localStorage.getItem(refreshTokenExpiresAtStorageKey) || '',
    userFullName: window.localStorage.getItem(userFullNameStorageKey) || '',
    userEmail: window.localStorage.getItem(userEmailStorageKey) || '',
    userWalletAddress: window.localStorage.getItem(userWalletAddressStorageKey) || '',
    userId: window.localStorage.getItem(userIdStorageKey) || '',
    userRole: window.localStorage.getItem(userRoleStorageKey) || ''
  };
};

/**
 * Hook kiểm tra trạng thái đăng nhập tại thời điểm render.
 * Mục đích: đọc auth state từ localStorage một cách đồng bộ (không qua useEffect)
 * để không gây flash nội dung khi chưa đăng nhập.
 *
 * Trả về:
 * - isLoggedIn: true nếu có accessToken hợp lệ
 * - sessionData: toàn bộ dữ liệu phiên
 *
 * Cách hoạt động:
 * - Initializer function kiểm tra typeof window !== 'undefined' trước khi truy cập localStorage.
 * - Khi login thành công (event dcpAuthSessionUpdated được fire),
 *   state được cập nhật ngay lập tức, modal đăng nhập tự động đóng.
 * - Trên server: trả về empty session (accessToken = '').
 * - Trên client (lần render đầu): đọc localStorage thực tế → xác định isLoggedIn thực sự.
 */
export function useAuthCheck() {
  // Ghi chú: Initializer chạy đồng bộ tại thời điểm render — không có flash.
  // typeof window check giúp an toàn khi chạy trên Next.js SSR.
  const [sessionData, setSessionData] = useState(getInitialSessionData);

  // Ghi chú: State logged-in computed từ sessionData để đảm bảo re-render khi auth thay đổi.
  const isLoggedIn = Boolean(sessionData.accessToken);

  /**
   * Hàm đồng bộ lại session data từ localStorage.
   * Mục đích: dùng làm handler cho auth session update event.
   */
  const syncSessionFromStorage = useCallback(() => {
    setSessionData(getInitialSessionData);
  }, []);

  /**
   * Đăng ký listener cho auth session update event.
   * Mục đích: khi người dùng đăng nhập thành công qua modal,
   * event được fire từ persistAuthSession → hook tự cập nhật state → modal đóng.
   */
  useEffect(() => {
    const eventName = 'dcpAuthSessionUpdated';

    window.addEventListener(eventName, syncSessionFromStorage);
    return () => {
      window.removeEventListener(eventName, syncSessionFromStorage);
    };
  }, [syncSessionFromStorage]);

  return {
    isLoggedIn,
    sessionData,
    syncSessionFromStorage
  };
}
