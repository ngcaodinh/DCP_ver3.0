import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const {
  mockClearAuthSession,
  mockFetch,
  mockFetchApi,
  mockReadAuthSession,
  mockRefreshAuthSession,
  mockRouter,
  mockRouterReplace
} = vi.hoisted(() => {
  const mockRouterReplace = vi.fn();

  return {
    mockClearAuthSession: vi.fn(),
    mockFetch: vi.fn(),
    mockFetchApi: vi.fn(),
    mockReadAuthSession: vi.fn(),
    mockRefreshAuthSession: vi.fn(),
    mockRouter: { replace: mockRouterReplace },
    mockRouterReplace
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() })
}));

vi.mock('@/app/utils/authSession', () => ({
  clearAuthSession: mockClearAuthSession,
  readAuthSession: mockReadAuthSession
}));

vi.mock('@/app/utils/authSessionRefresh', () => ({
  refreshAuthSession: mockRefreshAuthSession
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (pathname: string) => `http://api.test${pathname}`,
  fetchApi: mockFetchApi
}));

vi.mock('@/app/components/notifications/NotificationBell', () => ({ default: () => <div>Thông báo</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/AuditTable', () => ({ default: () => <div>Nhật ký</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/DisbursementStatusCard', () => ({ default: () => <div>Trạng thái giải ngân</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/MetricCard', () => ({ default: () => <div>Chỉ số</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/NonDashboardPanel', () => ({ default: () => <div>Panel nghiệp vụ</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/RequestDrawer', () => ({ default: () => <div>Chi tiết yêu cầu</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/Sidebar', () => ({ default: () => <aside>Điều hướng Regulatory</aside> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/ToastStack', () => ({ default: () => <div>Thông báo nhanh</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/Topbar', () => ({ default: () => <div>Thanh điều hướng</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/UrgentTable', () => ({ default: () => <div>Yêu cầu khẩn cấp</div> }));
vi.mock('@/app/components/systemAdmin/tailwind/OverrideVoteDrawer', () => ({ default: () => <div>Ghi đè GPS</div> }));
vi.mock('@/app/hooks/useOverrideDrawerController', () => ({ useOverrideDrawerController: () => undefined }));

import RegulatoryBodiesPageClientTailwind from '@/app/components/regulatoryBodies/RegulatoryBodiesPageClientTailwind';

/** Tạo phản hồi xác thực server tối thiểu cho guard trang Regulatory. */
function createAuthResponse(role: string): Response {
  return {
    ok: true,
    json: async () => ({ user: { role } })
  } as Response;
}

/** Tạo phản hồi hết hạn access token để kiểm tra luồng tự khôi phục phiên sau F5. */
function createUnauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    json: async () => ({ message: 'Access token expired' })
  } as Response;
}

describe('RegulatoryBodiesPageClientTailwind access guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetchApi.mockResolvedValue({ data: { requests: [], logs: [] } });
  });

  it('does not mount the protected shell after rejecting a non-regulatory session', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: 'donor-token', userRole: 'donor' });
    mockFetch.mockResolvedValue(createAuthResponse('donor'));

    render(<RegulatoryBodiesPageClientTailwind />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/'));
    expect(mockClearAuthSession).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Tổng quan' })).not.toBeInTheDocument();
    expect(screen.queryByText('Panel nghiệp vụ')).not.toBeInTheDocument();
  });

  it('mounts the protected shell after the server confirms a regulatory role', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: 'regulatory-token', userRole: 'regulatory' });
    mockFetch.mockResolvedValue(createAuthResponse('regulatory'));

    render(<RegulatoryBodiesPageClientTailwind />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      'http://api.test/auth/me',
      expect.objectContaining({ method: 'GET' })
    ));
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Tổng quan Giám sát' })).toBeInTheDocument();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
  });

  it('restores an expired access token before redirecting a regulatory user after F5', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: 'expired-token', userRole: 'regulatory' });
    mockRefreshAuthSession.mockResolvedValue({ status: 'REFRESHED', accessToken: 'refreshed-token' });
    mockFetch
      .mockResolvedValueOnce(createUnauthorizedResponse())
      .mockResolvedValueOnce(createAuthResponse('regulatory'));

    render(<RegulatoryBodiesPageClientTailwind />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockRefreshAuthSession).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://api.test/auth/me',
      expect.objectContaining({ headers: { Authorization: 'Bearer refreshed-token' } })
    );
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Tổng quan Giám sát' })).toBeInTheDocument();
  });
});
