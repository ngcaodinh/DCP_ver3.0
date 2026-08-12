import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockPush = vi.fn();
const mockRefetch = vi.fn(() => Promise.resolve({}));
const mockMutateAsync = vi.fn(() => Promise.resolve({ notificationId: 'NOTI-1' }));
const mockUseNotifications = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/app/hooks/useNotifications', () => ({
  useNotifications: () => mockUseNotifications(),
  useMarkNotificationAsRead: () => ({ isPending: false, mutateAsync: mockMutateAsync })
}));
vi.mock('@/app/hooks/useNotificationPolling', () => ({
  useNotificationPolling: ({ enabled }: { enabled: boolean }) => (enabled ? mockRefetch : () => undefined)
}));

import NotificationBell from '@/app/components/notifications/NotificationBell';

/** Trả query state tối thiểu để kiểm chứng hành vi người dùng của Bell. */
function createNotificationsQuery(overrides: Record<string, unknown> = {}) {
  return {
    isEnabled: true,
    data: { notifications: [], unreadCount: 0, pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false } },
    isPending: false,
    isError: false,
    error: undefined,
    refetch: mockRefetch,
    ...overrides
  };
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseNotifications.mockReturnValue(createNotificationsQuery());
    mockMutateAsync.mockResolvedValue({ notificationId: 'NOTI-1' });
  });

  it('hiển thị badge đúng và mở empty state bằng trigger có ARIA', () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({
      data: { notifications: [], unreadCount: 12, pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false } }
    }));
    render(<NotificationBell />);

    const trigger = screen.getByRole('button', { name: '12 thông báo chưa đọc' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('9+')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Không có thông báo nào')).toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('không render badge khi không có thông báo chưa đọc', () => {
    render(<NotificationBell />);

    expect(screen.getByRole('button', { name: '0 thông báo chưa đọc' })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('hiển thị loading state của GET-list khi Bell được mở', () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({ data: undefined, isPending: true }));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('hiển thị lỗi GET-list và cho phép retry mà không crash', () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({
      data: undefined,
      isError: true,
      error: { statusCode: 500 }
    }));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));
    mockRefetch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('giữ error state khi query trả lỗi không có statusCode', () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({
      data: undefined,
      isError: true,
      error: null
    }));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('đóng dropdown bằng Escape và click ngoài vùng Bell', () => {
    render(<><NotificationBell /><button type="button">Ngoài</button></>);
    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));
    expect(screen.getByRole('region', { name: 'Danh sách thông báo' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getAllByRole('button')[0]).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'Danh sách thông báo' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Ngoài' }));
    expect(screen.queryByRole('region', { name: 'Danh sách thông báo' })).not.toBeInTheDocument();
  });

  it('mark unread item trước và không điều hướng khi metadata chưa có contract whitelist', async () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({
      data: {
        unreadCount: 1,
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false },
        notifications: [{ notificationId: 'NOTI-1', notificationType: 'SYSTEM', title: 'Thông báo hệ thống', content: 'Nội dung', isRead: false, metadata: { url: 'https://unsafe.example' }, createdAt: '2026-08-10T00:00:00.000Z' }]
      }
    }));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole('button', { name: '1 thông báo chưa đọc' }));
    fireEvent.click(screen.getByRole('button', { name: /Thông báo hệ thống, chưa đọc/ }));

    await Promise.resolve();
    expect(mockMutateAsync).toHaveBeenCalledWith('NOTI-1');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('hiển thị auth handoff và không refetch khi query bị disable', () => {
    mockUseNotifications.mockReturnValue(createNotificationsQuery({ isEnabled: false, data: undefined, isPending: true }));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole('button', { name: '0 thông báo chưa đọc' }));

    expect(screen.getByText('Bạn cần đăng nhập để xem thông báo.')).toBeInTheDocument();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('giữ dropdown mở khi mark-read thất bại để user có thể retry', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('network'));
    mockUseNotifications.mockReturnValue(createNotificationsQuery({
      data: {
        unreadCount: 1,
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false },
        notifications: [{ notificationId: 'NOTI-ERROR', notificationType: 'SYSTEM', title: 'Lỗi', content: 'Nội dung', isRead: false, metadata: {}, createdAt: '2026-08-10T00:00:00.000Z' }]
      }
    }));

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: '1 thông báo chưa đọc' }));
    fireEvent.click(screen.getByRole('button', { name: /Lỗi, chưa đọc/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không thể đánh dấu thông báo đã đọc. Vui lòng thử lại.'));
    expect(screen.getByRole('region', { name: 'Danh sách thông báo' })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
