import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockRefetch = vi.fn(() => Promise.resolve({}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/app/hooks/useNotifications', () => ({
  useNotifications: () => ({
    isEnabled: true,
    data: { notifications: [], unreadCount: 0, pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false } },
    isPending: false,
    isError: false,
    error: undefined,
    refetch: mockRefetch
  }),
  useMarkNotificationAsRead: () => ({ isPending: false, mutateAsync: vi.fn() })
}));
vi.mock('@/app/hooks/useNotificationPolling', () => ({
  useNotificationPolling: () => mockRefetch
}));

import Topbar from '@/app/components/systemAdmin/tailwind/Topbar';
import NotificationBell from '@/app/components/notifications/NotificationBell';

describe('System Admin notification mount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('System Admin Topbar nhận shared NotificationBell thật qua notification slot', () => {
    render(
      <Topbar
        breadcrumbTitle="Tá»•ng quan"
        userDisplayName="Admin"
        userEmail="admin@example.com"
        userWalletAddress="0x1234"
        notificationContent={<NotificationBell />}
        onLogout={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: '0 thông báo chưa đọc' })).toBeInTheDocument();
  });
});
