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

import Topbar from '@/app/components/regulatoryBodies/tailwind/Topbar';
import NotificationBell from '@/app/components/notifications/NotificationBell';

describe('Organization and Regulatory notification mount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shared topbar renders the actual NotificationBell for Organization and Regulatory shells', () => {
    render(
      <>
        <Topbar
          breadcrumbTitle="Tổ chức"
          userDisplayName="Organization"
          userEmail="organization@example.com"
          userWalletAddress="0x1234"
          notificationContent={<NotificationBell />}
          onOpenMobileMenu={() => undefined}
          onLogout={() => undefined}
        />
        <Topbar
          breadcrumbTitle="Cơ quan giám sát"
          userDisplayName="Regulatory"
          userEmail="regulatory@example.com"
          userWalletAddress="0x5678"
          notificationContent={<NotificationBell />}
          onOpenMobileMenu={() => undefined}
          onLogout={() => undefined}
        />
      </>
    );

    expect(screen.getAllByRole('button', { name: '0 thông báo chưa đọc' })).toHaveLength(2);
  });
});
