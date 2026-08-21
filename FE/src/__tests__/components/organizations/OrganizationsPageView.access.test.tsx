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
} = vi.hoisted(() => ({
  mockClearAuthSession: vi.fn(),
  mockFetch: vi.fn(),
  mockFetchApi: vi.fn(),
  mockReadAuthSession: vi.fn(),
  mockRefreshAuthSession: vi.fn(),
  mockRouter: { replace: vi.fn(), refresh: vi.fn() },
  mockRouterReplace: vi.fn()
}));

mockRouter.replace = mockRouterReplace;

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (pathname: string) => `http://api.test${pathname}`,
  fetchApi: mockFetchApi
}));

vi.mock('@/app/utils/authSession', () => ({
  clearAuthSession: mockClearAuthSession,
  readAuthSession: mockReadAuthSession
}));

vi.mock('@/app/utils/authSessionRefresh', () => ({
  refreshAuthSession: mockRefreshAuthSession
}));

vi.mock('@/app/components/notifications/NotificationBell', () => ({ default: () => <div>Thông báo</div> }));
vi.mock('@/app/components/regulatoryBodies/tailwind/Topbar', () => ({ default: () => <div>Thanh điều hướng</div> }));
vi.mock('@/app/components/organizations/OrganizationsSections', () => ({
  CreateDisbursementModal: () => null,
  CreateProjectModal: () => null,
  DashboardSection: () => <div>Trang tổng quan tổ chức</div>,
  DisbursementSection: () => <div>Giải ngân</div>,
  ProjectsSection: () => <div data-testid="projects-section">Dự án</div>,
  SettingsSection: () => <div>Cài đặt</div>,
  TransparencySection: () => <div>Minh bạch</div>
}));

import OrganizationsPageView from '@/app/components/organizations/OrganizationsPageView';

/** Tạo phản hồi profile tối thiểu để xác nhận role organizations qua guard server. */
function createOrganizationProfileResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ user: { role: 'organizations' } })
  } as Response;
}

/** Tạo phản hồi access token hết hạn để kiểm tra luồng refresh sau F5. */
function createUnauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    json: async () => ({ message: 'Access token expired' })
  } as Response;
}

describe('OrganizationsPageView access guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockReadAuthSession.mockReturnValue({ accessToken: 'organization-token', userRole: 'organizations' });
    mockFetchApi.mockResolvedValue({ data: [] });
  });

  it('keeps a valid session when the access guard is rate limited', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    render(<OrganizationsPageView />);

    expect(await screen.findByText('Hệ thống đang giới hạn tần suất xác thực. Vui lòng thử lại sau ít phút.')).toBeInTheDocument();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token before redirecting an organization user', async () => {
    mockFetch
      .mockResolvedValueOnce(createUnauthorizedResponse())
      .mockResolvedValueOnce(createOrganizationProfileResponse());
    mockRefreshAuthSession.mockResolvedValue({ status: 'REFRESHED', accessToken: 'refreshed-organization-token' });

    render(<OrganizationsPageView />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockRefreshAuthSession).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/auth/me'),
      expect.objectContaining({ headers: { Authorization: 'Bearer refreshed-organization-token' } })
    );
    expect(await screen.findByText('Trang tổng quan tổ chức')).toBeInTheDocument();
    expect(mockClearAuthSession).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('opens the My Projects tab when it receives projects as the initial page', async () => {
    mockFetch.mockResolvedValue(createOrganizationProfileResponse());

    render(<OrganizationsPageView initialPage="projects" />);

    expect(await screen.findByTestId('projects-section')).toBeInTheDocument();
  });
});
