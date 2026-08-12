import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((pathname: string) => pathname),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
  authenticationSessionUpdatedEventName: 'dcpAuthSessionUpdated'
}));

import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { normalizeMarkNotificationReadResponse, normalizeNotificationListResponse, type NotificationListResponse } from '@/app/components/notifications/types';
import { notificationQueryKeys, useMarkNotificationAsRead, useNotifications } from '@/app/hooks/useNotifications';

/** Dựng QueryClient cô lập để cache giữa các test notification không ảnh hưởng nhau. */
function renderWithQuery<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper }), queryClient };
}

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'notification-token' } as never);
  });

  it('lấy đúng trang đầu tối đa 20 item cùng Bearer token', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: {
        notifications: [],
        unreadCount: 2,
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1, hasNextPage: false }
      }
    } as never);

    const { result } = renderWithQuery(() => useNotifications());

    await waitFor(() => expect(result.current.data?.unreadCount).toBe(2));
    expect(buildApiUrl).toHaveBeenCalledWith('/api/notifications?page=1&limit=20');
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/notifications?page=1&limit=20',
      { headers: { Authorization: 'Bearer notification-token' } }
    );
  });

  it('cập nhật badge cache sau khi PATCH mark-read thành công', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({
        success: true,
        message: '',
        data: {
          notifications: [{ notificationId: 'NOTI-1', notificationType: 'SYSTEM', title: 'Thông báo', content: 'Nội dung', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
          unreadCount: 1,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
        }
      } as never)
      .mockResolvedValueOnce({ success: true, message: '', data: { notificationId: 'NOTI-1' } } as never);

    const { result } = renderWithQuery(() => ({ notifications: useNotifications(), markAsRead: useMarkNotificationAsRead() }));

    await waitFor(() => expect(result.current.notifications.data?.unreadCount).toBe(1));
    await act(async () => {
      await result.current.markAsRead.mutateAsync('NOTI-1');
    });

    expect(fetchApi).toHaveBeenCalledWith(
      '/api/notifications/NOTI-1/read',
      { method: 'PATCH', headers: { Authorization: 'Bearer notification-token' } }
    );
    await waitFor(() => {
      expect(result.current.notifications.data?.unreadCount).toBe(0);
      expect(result.current.notifications.data?.notifications[0]?.isRead).toBe(true);
    });
  });

  it('refetch để hội tụ khi BE trả 404 cho notification đã được đọc ở nơi khác', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({
        success: true,
        message: '',
        data: {
          notifications: [{ notificationId: 'NOTI-404', notificationType: 'SYSTEM', title: 'Thông báo', content: 'Nội dung', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
          unreadCount: 1,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
        }
      } as never)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Đã đọc', errorCode: 'NOTIFICATION_NOT_FOUND' } as never)
      .mockResolvedValueOnce({
        success: true,
        message: '',
        data: {
          notifications: [{ notificationId: 'NOTI-404', notificationType: 'SYSTEM', title: 'Thông báo', content: 'Nội dung', isRead: true, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
          unreadCount: 0,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
        }
      } as never);

    const { result } = renderWithQuery(() => ({ notifications: useNotifications(), markAsRead: useMarkNotificationAsRead() }));
    await waitFor(() => expect(result.current.notifications.data?.unreadCount).toBe(1));

    await act(async () => {
      await expect(result.current.markAsRead.mutateAsync('NOTI-404')).rejects.toMatchObject({ statusCode: 404 });
    });

    await waitFor(() => expect(result.current.notifications.data?.unreadCount).toBe(0));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/notifications/NOTI-404/read',
      { method: 'PATCH', headers: { Authorization: 'Bearer notification-token' } }
    );
  });

  it('không gửi request khi không có access token', () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' } as never);

    const { result } = renderWithQuery(() => useNotifications());

    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('từ chối response list thiếu field bắt buộc trước khi ghi cache', () => {
    expect(() => normalizeNotificationListResponse({
      notifications: [{ notificationId: 'NOTI-INVALID', isRead: false }],
      unreadCount: 1,
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
    })).toThrow('Phản hồi danh sách thông báo không hợp lệ.');
  });

  it('từ chối unreadCount không phải số nguyên', () => {
    expect(() => normalizeNotificationListResponse({
      notifications: [],
      unreadCount: 1.5,
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false }
    })).toThrow('Phản hồi danh sách thông báo không hợp lệ.');
  });

  it('từ chối response mark-read thiếu notificationId', () => {
    expect(() => normalizeMarkNotificationReadResponse({})).toThrow('Phản hồi đánh dấu thông báo không hợp lệ.');
  });

  it('từ chối response mark-read lệch notificationId và không cập nhật cache', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({
        success: true,
        message: '',
        data: {
          notifications: [{ notificationId: 'NOTI-MISMATCH', notificationType: 'SYSTEM', title: 'Thông báo', content: 'Nội dung', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
          unreadCount: 1,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
        }
      } as never)
      .mockResolvedValueOnce({ success: true, message: '', data: { notificationId: 'NOTI-OTHER' } } as never);

    const { result } = renderWithQuery(() => ({ notifications: useNotifications(), markAsRead: useMarkNotificationAsRead() }));
    await waitFor(() => expect(result.current.notifications.data?.unreadCount).toBe(1));

    await act(async () => {
      await expect(result.current.markAsRead.mutateAsync('NOTI-MISMATCH')).rejects.toThrow('Phản hồi đánh dấu thông báo không khớp với yêu cầu.');
    });

    expect(result.current.notifications.data?.unreadCount).toBe(1);
    expect(result.current.notifications.data?.notifications[0]?.isRead).toBe(false);
  });

  it('không ghi response mark-read của phiên cũ vào cache user mới', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-a', userId: 'user-a' } as never);
    let resolveMarkRead: ((value: unknown) => void) | undefined;
    const pendingMarkRead = new Promise<unknown>((resolve) => {
      resolveMarkRead = resolve;
    });
    vi.mocked(fetchApi).mockImplementation((input) => {
      if (String(input).includes('/read')) {
        return pendingMarkRead as never;
      }
      return Promise.resolve({
        success: true,
        message: '',
        data: {
          notifications: [{ notificationId: 'NOTI-RACE', notificationType: 'SYSTEM', title: 'A', content: 'A', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
          unreadCount: 1,
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
        }
      }) as never;
    });

    const { result, queryClient } = renderWithQuery(() => ({ notifications: useNotifications(), markAsRead: useMarkNotificationAsRead() }));
    await waitFor(() => expect(result.current.notifications.data?.unreadCount).toBe(1));
    const markReadPromise = result.current.markAsRead.mutateAsync('NOTI-RACE');

    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-b', userId: 'user-b' } as never);
    act(() => window.dispatchEvent(new Event('dcpAuthSessionUpdated')));
    await waitFor(() => expect(queryClient.getQueryData<NotificationListResponse>(notificationQueryKeys.list('user-b'))?.notifications[0]?.title).toBe('A'));
    const userBData = {
      notifications: [{ notificationId: 'NOTI-RACE', notificationType: 'SYSTEM', title: 'B', content: 'B', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }],
      unreadCount: 1,
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
    };
    queryClient.setQueryData(notificationQueryKeys.list('user-b'), userBData);

    await act(async () => {
      resolveMarkRead?.({ success: true, message: '', data: { notificationId: 'NOTI-RACE' } });
      await markReadPromise;
    });

    expect(queryClient.getQueryData(notificationQueryKeys.list('user-b'))).toEqual(userBData);
  });

  it('re-enables the query when auth changes on the same route', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' } as never);
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: {
        notifications: [],
        unreadCount: 0,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false }
      }
    } as never);

    const { result, queryClient } = renderWithQuery(() => useNotifications());
    expect(result.current.isEnabled).toBe(false);

    queryClient.setQueryData(notificationQueryKeys.list(''), {
      notifications: [],
      unreadCount: 99,
      pagination: { page: 1, limit: 20, total: 99, totalPages: 5, hasNextPage: true }
    });

    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'signed-in-token' } as never);
    act(() => window.dispatchEvent(new Event('dcpAuthSessionUpdated')));

    await waitFor(() => expect(result.current.data?.unreadCount).toBe(0));
    expect(result.current.isEnabled).toBe(true);
    expect(queryClient.getQueryData(notificationQueryKeys.list(''))).not.toMatchObject({ unreadCount: 99 });

    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' } as never);
    act(() => window.dispatchEvent(new Event('dcpAuthSessionUpdated')));
    await waitFor(() => expect(result.current.isEnabled).toBe(false));
    expect(queryClient.getQueryData(notificationQueryKeys.list(''))).toBeUndefined();
  });
});
