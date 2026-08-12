import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockMutateAsync = vi.fn();
const mockPreferencesQuery = vi.fn();

vi.mock('@/app/hooks/useNotificationPreferences', () => ({
  useNotificationPreferences: () => mockPreferencesQuery(),
  useUpdateNotificationPreferences: () => ({ isPending: false, mutateAsync: mockMutateAsync })
}));

import NotificationPanel from '@/app/components/notifications/NotificationPanel';

const preferences = {
  version: 0,
  globalEnabled: true,
  preferences: {
    LARGE_DONATION: { IN_APP: true, EMAIL: true, PUSH: false },
    DISBURSEMENT_COMPLETED: { IN_APP: true, EMAIL: true },
    MANUAL_REVIEW_ESCALATION: { IN_APP: true, EMAIL: true },
    OVERRIDE_APPROVED: { IN_APP: true, EMAIL: true },
    SBT_MINT_FAILED: { IN_APP: true, EMAIL: true },
    DONATION_RECEIVED: { IN_APP: true, SMS: false },
    FUTURE_NOTIFICATION_TYPE: { IN_APP: false, CUSTOM: true }
  }
};

/** Cấu hình query state thành dữ liệu preference đã load. */
function createPreferenceQuery(overrides: Record<string, unknown> = {}) {
  return {
    isEnabled: true,
    isPending: false,
    isError: false,
    error: undefined,
    data: preferences,
    refetch: vi.fn(),
    ...overrides
  };
}

describe('NotificationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferencesQuery.mockReturnValue(createPreferenceQuery());
    mockMutateAsync.mockResolvedValue(preferences);
  });

  it('email toggle off gửi full map giữ nguyên channel và key không render', async () => {
    render(<NotificationPanel />);

    fireEvent.click(screen.getByLabelText('Quyên góp lớn'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      currentPreferences: preferences,
      emailValues: {
        LARGE_DONATION: false,
        DISBURSEMENT_COMPLETED: true,
        MANUAL_REVIEW_ESCALATION: true,
        OVERRIDE_APPROVED: true,
        SBT_MINT_FAILED: true
      }
    });
    expect(screen.getByText('Đã lưu cài đặt')).toBeInTheDocument();
  });

  it('giữ lựa chọn để retry và báo toast lỗi khi PUT thất bại', async () => {
    mockMutateAsync.mockRejectedValue(new Error('network'));
    render(<NotificationPanel />);

    const toggle = screen.getByLabelText('Quyên góp lớn') as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));

    await waitFor(() => expect(screen.getByText('Không thể lưu cài đặt')).toBeInTheDocument());
    expect(toggle.checked).toBe(false);
  });

  it('refreshes version on conflict without overwriting local toggle', async () => {
    const refetch = vi.fn();
    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ refetch }));
    mockMutateAsync.mockRejectedValue({ statusCode: 409 });
    render(<NotificationPanel />);

    const toggle = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(toggle.checked).toBe(false);
  });

  it('bỏ qua success của PUT cũ sau khi session thay đổi', async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    mockMutateAsync.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ sessionKey: 'session-a' }));
    const { rerender } = render(<NotificationPanel />);

    fireEvent.click(screen.getByLabelText('Quyên góp lớn'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));

    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ sessionKey: 'session-b' }));
    rerender(<NotificationPanel />);
    await act(async () => {
      resolveUpdate?.(preferences);
      await Promise.resolve();
    });

    expect(screen.queryByText('Đã lưu cài đặt')).not.toBeInTheDocument();
  });

  it('hiển thị trạng thái an toàn khi chưa đăng nhập hoặc API bị cấm', () => {
    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ isEnabled: false, data: undefined }));
    const { rerender } = render(<NotificationPanel />);
    expect(screen.getByText('Bạn cần đăng nhập để xem cài đặt thông báo.')).toBeInTheDocument();

    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ isError: true, data: undefined, error: { statusCode: 403 } }));
    rerender(<NotificationPanel />);
    expect(screen.getByText('Bạn không có quyền thay đổi cài đặt thông báo.')).toBeInTheDocument();
  });

  it('hiển thị loading state khi preference query đang tải', () => {
    mockPreferencesQuery.mockReturnValue(createPreferenceQuery({ data: undefined, isPending: true }));
    render(<NotificationPanel />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
