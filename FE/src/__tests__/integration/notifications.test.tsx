import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockPush = vi.fn();
const mockFetchApi = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (pathname: string) => pathname,
  fetchApi: (...args: unknown[]) => mockFetchApi(...args)
}));
vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: () => ({ accessToken: 'integration-token', userId: 'integration-user' }),
  authenticationSessionUpdatedEventName: 'dcpAuthSessionUpdated'
}));

import NotificationBell from '@/app/components/notifications/NotificationBell';
import NotificationPanel from '@/app/components/notifications/NotificationPanel';

const notificationList = {
  notifications: [{
    notificationId: 'NOTI-INTEGRATION',
    notificationType: 'SYSTEM',
    title: 'Thông báo tích hợp',
    content: 'Nội dung kiểm chứng cache',
    isRead: false,
    metadata: {},
    createdAt: '2026-08-10T00:00:00.000Z'
  }],
  unreadCount: 1,
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false }
};

const preferences = {
  version: 0,
  globalEnabled: true,
  preferences: {
    LARGE_DONATION: { IN_APP: true, EMAIL: true, PUSH: false },
    DISBURSEMENT_COMPLETED: { IN_APP: true, EMAIL: true },
    MANUAL_REVIEW_ESCALATION: { IN_APP: true, EMAIL: true },
    OVERRIDE_APPROVED: { IN_APP: true, EMAIL: true },
    SBT_MINT_FAILED: { IN_APP: true, EMAIL: true },
    FUTURE_NOTIFICATION_TYPE: { IN_APP: false, CUSTOM: true }
  }
};

/** Tạo QueryClient độc lập để integration test không chia sẻ server state giữa các scenario. */
function renderWithQueryClient(children: ReactNode): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe('notification integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchApi.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/read')) {
        return Promise.resolve({ success: true, message: '', data: { notificationId: 'NOTI-INTEGRATION' } });
      }
      if (input.includes('/preferences') && init?.method === 'PUT') {
        return Promise.resolve({ success: true, message: '', data: preferences });
      }
      if (input.includes('/preferences')) {
        return Promise.resolve({ success: true, message: '', data: preferences });
      }
      return Promise.resolve({ success: true, message: '', data: notificationList });
    });
  });

  it('đi từ list đến mark-read và cập nhật badge qua QueryClient cache', async () => {
    renderWithQueryClient(<NotificationBell />);

    await waitFor(() => expect(screen.getByRole('button', { name: '1 thông báo chưa đọc' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '1 thông báo chưa đọc' }));
    fireEvent.click(await screen.findByRole('button', { name: /Thông báo tích hợp, chưa đọc/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: '0 thông báo chưa đọc' })).toBeInTheDocument());
    expect(mockFetchApi).toHaveBeenCalledWith(
      '/api/notifications/NOTI-INTEGRATION/read',
      { method: 'PATCH', headers: { Authorization: 'Bearer integration-token' } }
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('submit settings gửi full map, giữ future key và hiển thị success toast', async () => {
    renderWithQueryClient(<NotificationPanel />);

    const toggle = await screen.findByLabelText('Quyên góp lớn') as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));

    await waitFor(() => expect(screen.getByText('Đã lưu cài đặt')).toBeInTheDocument());
    const putCall = mockFetchApi.mock.calls.find(([input, init]) => input === '/api/notifications/preferences' && init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall?.[1] as RequestInit).body as string) as typeof preferences;
    expect(body.version).toBe(0);
    expect(body.preferences.LARGE_DONATION.EMAIL).toBe(false);
    expect(body.preferences.FUTURE_NOTIFICATION_TYPE).toEqual({ IN_APP: false, CUSTOM: true });
  });
});
