'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import {
  normalizeMarkNotificationReadResponse,
  normalizeNotificationListResponse,
  type MarkNotificationReadResponse,
  type NotificationListResponse
} from '@/app/components/notifications/types';
import {
  isNotificationSessionCurrent,
  readNotificationSessionSnapshot,
  useNotificationSession,
  type NotificationSessionSnapshot
} from './useNotificationSession';

const NOTIFICATION_PAGE_LIMIT = 20;

export const notificationQueryKeys = {
  all: ['notifications'] as const,
  list: (userId: string) => ['notifications', 'list', userId || 'anonymous', { page: 1, limit: NOTIFICATION_PAGE_LIMIT }] as const
};

/** Lấy access token hiện tại hoặc ném lỗi trước khi gọi network để không gửi Bearer rỗng. */
function getAccessToken(): string {
  if (typeof window === 'undefined') {
    throw new Error('Chưa đăng nhập');
  }
  const accessToken = readAuthSession()?.accessToken;
  if (!accessToken) {
    throw new Error('Chưa đăng nhập');
  }
  return accessToken;
}

/** Gọi trang đầu notification theo giới hạn BE cho phép và unwrap API envelope có sẵn. */
async function fetchNotifications(): Promise<NotificationListResponse> {
  const accessToken = getAccessToken();
  const response = await fetchApi<unknown>(
    buildApiUrl(`/api/notifications?page=1&limit=${NOTIFICATION_PAGE_LIMIT}`),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return normalizeNotificationListResponse(response.data);
}

/** Gọi PATCH để đánh dấu một notification là đã đọc. */
async function markNotificationAsRead(notificationId: string): Promise<MarkNotificationReadResponse> {
  const accessToken = getAccessToken();
  const response = await fetchApi<unknown>(
    buildApiUrl(`/api/notifications/${encodeURIComponent(notificationId)}/read`),
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  const normalizedResponse = normalizeMarkNotificationReadResponse(response.data);
  if (normalizedResponse.notificationId !== notificationId) {
    throw new Error('Phản hồi đánh dấu thông báo không khớp với yêu cầu.');
  }
  return normalizedResponse;
}

/** Không retry lỗi xác thực/quyền, còn lại chỉ thử lại tối đa một lần như policy QueryClient. */
function shouldRetryNotificationQuery(failureCount: number, error: ApiErrorResponse): boolean {
  if (error.statusCode === 401 || error.statusCode === 403) {
    return false;
  }
  return failureCount < 1;
}

/** Cập nhật cache list sau khi mark-read thành công để badge phản hồi ngay trước lần revalidate kế tiếp. */
function markCachedNotificationAsRead(
  currentData: NotificationListResponse | undefined,
  notificationId: string
): NotificationListResponse | undefined {
  if (!currentData) {
    return currentData;
  }

  const notification = currentData.notifications.find((item) => item.notificationId === notificationId);
  if (!notification || notification.isRead) {
    return currentData;
  }

  return {
    ...currentData,
    unreadCount: Math.max(0, currentData.unreadCount - 1),
    notifications: currentData.notifications.map((item) => (
      item.notificationId === notificationId ? { ...item, isRead: true } : item
    ))
  };
}

interface NotificationMutationContext extends NotificationSessionSnapshot {
  queryKey: ReturnType<typeof notificationQueryKeys.list>;
}

/** Chụp session và cache key tại thời điểm bắt đầu mutation để ngăn response cũ ghi vào user mới. */
function captureNotificationMutationContext(): NotificationMutationContext {
  const sessionSnapshot = readNotificationSessionSnapshot();
  return {
    ...sessionSnapshot,
    queryKey: notificationQueryKeys.list(sessionSnapshot.userId)
  };
}

/** Hook TanStack Query là nguồn server state duy nhất cho danh sách và badge notification. */
export function useNotifications() {
  const { hasAccessToken, userId } = useNotificationSession();
  const query = useQuery<NotificationListResponse, ApiErrorResponse>({
    queryKey: notificationQueryKeys.list(userId),
    queryFn: fetchNotifications,
    enabled: hasAccessToken,
    retry: shouldRetryNotificationQuery
  });

  return { ...query, isEnabled: hasAccessToken };
}

/** Mutation mark-read, đồng bộ cache ngay khi thành công và refetch khi BE trả 404 do state đã hội tụ ở nơi khác. */
export function useMarkNotificationAsRead() {
  const queryClient = useQueryClient();

  return useMutation<MarkNotificationReadResponse, ApiErrorResponse, string, NotificationMutationContext>({
    mutationFn: markNotificationAsRead,
    onMutate: () => captureNotificationMutationContext(),
    onSuccess: (_response, notificationId, context) => {
      if (!context || !isNotificationSessionCurrent(context)) {
        return;
      }
      queryClient.setQueryData<NotificationListResponse>(
        context.queryKey,
        (currentData) => markCachedNotificationAsRead(currentData, notificationId)
      );
    },
    onError: (error, _notificationId, context) => {
      if (error.statusCode === 404 && context && isNotificationSessionCurrent(context)) {
        // BE dùng 404 cho cả item đã đọc; refetch giúp badge/list hội tụ thay vì giảm count lần nữa.
        void queryClient.invalidateQueries({ queryKey: context.queryKey });
      }
    }
  });
}
