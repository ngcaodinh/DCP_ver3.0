'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  authenticationSessionUpdatedEventName,
  readAuthSession
} from '@/app/utils/authSession';

interface NotificationSessionState {
  hasAccessToken: boolean;
  userId: string;
  sessionRevision: number;
}

export interface NotificationSessionSnapshot {
  accessToken: string;
  userId: string;
}

/** Đọc auth identity trong browser mà không truy cập localStorage khi SSR. */
export function readNotificationSessionSnapshot(): NotificationSessionSnapshot {
  if (typeof window === 'undefined') {
    return { accessToken: '', userId: '' };
  }

  const session = readAuthSession();
  return { accessToken: session.accessToken ?? '', userId: session.userId ?? '' };
}

/** Kiểm tra mutation notification còn thuộc đúng phiên đã khởi tạo request hay không. */
export function isNotificationSessionCurrent(snapshot: NotificationSessionSnapshot): boolean {
  const currentSnapshot = readNotificationSessionSnapshot();
  return currentSnapshot.accessToken === snapshot.accessToken
    && currentSnapshot.userId === snapshot.userId
    && currentSnapshot.accessToken.length > 0;
}

/** Chuyển snapshot auth thành state tối giản phục vụ việc bật/tắt query notification. */
function readNotificationSession(): NotificationSessionState {
  const snapshot = readNotificationSessionSnapshot();
  return { hasAccessToken: Boolean(snapshot.accessToken), userId: snapshot.userId, sessionRevision: 0 };
}

/** Theo dõi phiên đăng nhập, scope cache theo user và loại bỏ dữ liệu cũ khi đổi phiên. */
export function useNotificationSession(): NotificationSessionState {
  const queryClient = useQueryClient();
  const [sessionState, setSessionState] = useState(readNotificationSession);

  useEffect(() => {
    const handleAuthSessionUpdated = (): void => {
      const nextSessionState = readNotificationSession();
      // Luôn xoá cache khi auth event xảy ra; userId có thể thiếu ở session legacy.
      queryClient.removeQueries({ queryKey: ['notifications'] });
      setSessionState((currentSessionState) => ({
        ...nextSessionState,
        sessionRevision: currentSessionState.sessionRevision + 1
      }));
    };

    window.addEventListener(authenticationSessionUpdatedEventName, handleAuthSessionUpdated);
    return () => {
      window.removeEventListener(authenticationSessionUpdatedEventName, handleAuthSessionUpdated);
    };
  }, [queryClient]);

  return sessionState;
}
