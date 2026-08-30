import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClearAuthSession,
  mockReadAuthSession,
  mockRouterReplace,
  mockRouterPush,
} = vi.hoisted(() => ({
  mockClearAuthSession: vi.fn(),
  mockReadAuthSession: vi.fn(),
  mockRouterReplace: vi.fn(),
  mockRouterPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

vi.mock('@/app/utils/authSession', () => ({
  clearAuthSession: mockClearAuthSession,
  readAuthSession: mockReadAuthSession,
}));

vi.mock('@/app/components/notifications/NotificationBell', () => ({ default: () => <span>Thông báo</span> }));
vi.mock('@/app/components/systemAdmin/tailwind/NonDashboardPanel', () => ({
  default: ({ activePage }: { activePage: string }) => <div>Panel nghiệp vụ: {activePage}</div>,
}));
vi.mock('@/app/components/systemAdmin/tailwind/ToastStack', () => ({ default: () => null }));

import AdminPageClientTailwind from '@/app/components/systemAdmin/AdminPageClientTailwind';

describe('AdminPageClientTailwind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chặn phiên không có quyền Admin trước khi mount cổng quản trị', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: 'donor-token', userRole: 'donor' });
    render(<AdminPageClientTailwind />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/unauthorized'));
    expect(screen.queryByRole('heading', { name: 'Tổng quan hệ thống' })).not.toBeInTheDocument();
  });

  it('điều hướng về đăng nhập khi phiên không có access token', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: '', userRole: 'admin' });
    render(<AdminPageClientTailwind />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/login'));
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it('mở và đóng drawer điều hướng trên màn hình nhỏ cho Admin hợp lệ', async () => {
    mockReadAuthSession.mockReturnValue({
      accessToken: 'admin-token',
      userRole: 'admin',
      userFullName: 'Quản trị gốc',
      userEmail: '',
      userWalletAddress: '',
    });
    render(<AdminPageClientTailwind />);

    await screen.findByRole('heading', { name: 'Tổng quan hệ thống' });
    fireEvent.click(screen.getByRole('button', { name: 'Mở menu điều hướng' }));
    expect(screen.getByRole('dialog', { name: 'Menu điều hướng Admin' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Đóng menu điều hướng' }));
    expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Admin' })).not.toBeInTheDocument();
  });

  it('giữ shell Admin khi chọn hàng chờ, ghế Ủy ban và feedback', async () => {
    mockReadAuthSession.mockReturnValue({
      accessToken: 'admin-token',
      userRole: 'admin',
      userFullName: 'Quản trị gốc',
      userEmail: '',
      userWalletAddress: '',
    });
    render(<AdminPageClientTailwind />);

    await screen.findByRole('heading', { name: 'Tổng quan hệ thống' });

    fireEvent.click(screen.getByRole('button', { name: 'Hàng chờ chuyển khoản' }));
    expect(screen.getByText('Panel nghiệp vụ: transferQueue')).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ghế Ủy ban' }));
    expect(screen.getByText('Panel nghiệp vụ: committeeSeats')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Feedback bị gắn cờ' }));
    expect(screen.getByText('Panel nghiệp vụ: feedbackFlagging')).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('chỉ đăng xuất Admin sau khi xác nhận và quay về cổng Governance', async () => {
    mockReadAuthSession.mockReturnValue({
      accessToken: 'admin-token',
      userRole: 'admin',
      userFullName: 'Quản trị gốc',
      userEmail: '',
      userWalletAddress: '',
    });
    render(<AdminPageClientTailwind />);

    await screen.findByRole('heading', { name: 'Tổng quan hệ thống' });
    fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));

    const confirmationDialog = screen.getByRole('dialog', { name: 'Xác nhận đăng xuất' });
    expect(mockClearAuthSession).not.toHaveBeenCalled();

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Đăng xuất' }));

    expect(mockClearAuthSession).toHaveBeenCalledOnce();
    expect(mockRouterReplace).toHaveBeenCalledWith('/governance/login');
  });
});
