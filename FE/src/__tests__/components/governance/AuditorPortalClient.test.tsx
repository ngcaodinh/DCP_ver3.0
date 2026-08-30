import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mockClearAuthSession, mockFetchApi, mockRefreshAuthSession, mockRouterReplace, mockSession } = vi.hoisted(() => ({
  mockClearAuthSession: vi.fn(),
  mockFetchApi: vi.fn(),
  mockRefreshAuthSession: vi.fn(),
  mockRouterReplace: vi.fn(),
  mockSession: { accessToken: 'auditor-token', userRole: 'auditor' },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockRouterReplace }) }));
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, buildSameOriginApiUrl: (path: string) => path, fetchApi: mockFetchApi }));
vi.mock('@/app/utils/authSession', () => ({ clearAuthSession: mockClearAuthSession, readAuthSession: () => mockSession }));
vi.mock('@/app/utils/authSessionRefresh', () => ({ refreshAuthSession: mockRefreshAuthSession }));
vi.mock('@/app/components/common/evidenceCamera/EvidenceCameraCapture', () => ({
  EvidenceCameraCapture: () => <div data-testid="evidence-camera">camera</div>
}));
vi.mock('@/app/components/governance/AuditorFieldReportForm', () => ({
  default: ({ projects, onSubmitted }: { projects: Array<{ name: string }>; onSubmitted: () => Promise<void> }) => (
    <div><p>{projects[0]?.name || 'Không có dự án ACTIVE'}</p><button type="button" onClick={() => void onSubmitted()}>Gửi biên bản một lần</button></div>
  )
}));
vi.mock('@/app/components/governance/AuditorFieldReportHistory', () => ({ default: () => <div>Field report history</div> }));
vi.mock('@/app/components/governance/AuditorListingHistory', () => ({ default: () => <div>Listing history</div> }));
vi.mock('@/app/components/governance/AuditorListingVerificationForm', () => ({ default: () => <div>Listing verification form</div> }));

import AuditorPortalClient from '@/app/components/governance/AuditorPortalClient';

describe('AuditorPortalClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState({}, '', '/auditor');
    mockSession.accessToken = 'auditor-token';
    mockSession.userRole = 'auditor';
    mockRefreshAuthSession.mockResolvedValue({ status: 'REFRESHED', accessToken: 'fresh-auditor-token' });
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/auditor/pending-projects')) return Promise.resolve({ data: [] });
      if (url.includes('/auditor/active-projects')) return Promise.resolve({ data: [{ projectId: 'active-1', name: 'Dự án ACTIVE', milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', description: 'Đối chiếu tạm ứng' }], fieldReport: null }] });
      if (url.includes('/stake-overview')) return Promise.resolve({ data: { onchain: null, onchainError: null, guard: { walletLock: null, lockedAt: null, penaltyDebtVnd: 0, openCaseCount: 0 }, payoutAccount: null, accountStatus: 'ACTIVE', suspendedReasonCode: null, exitEligibility: null } });
      return Promise.resolve({ data: {} });
    });
  });

  it('hiển thị header nghiệp vụ Auditor và tải danh sách ACTIVE cho biên bản hiện trường', async () => {
    render(<AuditorPortalClient />);
    expect(screen.getAllByRole('tab')).toHaveLength(4);

    expect(screen.getByRole('tab', { name: 'Khiếu nại niêm yết' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Khiếu nại niêm yết' })).toHaveAttribute('aria-controls', 'auditor-challenges-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'Biên bản hiện trường' }));

    await waitFor(() => expect(screen.getByText('Dự án ACTIVE')).toBeInTheDocument());
    expect(screen.getByRole('tabpanel', { name: 'Biên bản hiện trường' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Biên bản hiện trường' })).toHaveAttribute('aria-labelledby', 'auditor-field-reports-tab');
    expect(mockFetchApi).toHaveBeenCalledWith('/api/project-governance/auditor/active-projects', expect.objectContaining({ headers: { Authorization: 'Bearer auditor-token' } }));
  });

  it('mở menu nghiệp vụ mobile, chọn biên bản hiện trường và khóa cuộn nền', async () => {
    render(<AuditorPortalClient />);

    fireEvent.click(screen.getByRole('button', { name: 'Mở menu' }));

    expect(screen.getByRole('dialog', { name: 'Menu nghiệp vụ Auditor' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Menu nghiệp vụ Auditor' }).parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'Biên bản hiện trường' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menu nghiệp vụ Auditor' })).getByRole('button', { name: 'Biên bản hiện trường' }));

    await waitFor(() => expect(screen.getByText('Dự án ACTIVE')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Menu nghiệp vụ Auditor' })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('chỉ tải dự án ACTIVE khi Auditor mở tab biên bản hiện trường', async () => {
    render(<AuditorPortalClient />);

    expect(await screen.findByText('Chưa có dự án trong cửa sổ rà soát')).toBeInTheDocument();
    expect(screen.getByText('Chỉ dự án đã được duyệt và đang niêm yết hoặc tranh chấp mới xuất hiện tại đây. Dự án ACTIVE được kiểm tra trong mục Biên bản hiện trường.')).toBeInTheDocument();
    expect(mockFetchApi.mock.calls.some(([url]) => String(url).includes('/auditor/active-projects'))).toBe(false);

    fireEvent.click(screen.getAllByRole('tab')[1]);

    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Dự án ACTIVE')).toBeInTheDocument();
  });

  it('refresh danh sách ACTIVE sau khi form biên bản báo submit thành công', async () => {
    render(<AuditorPortalClient />);
    fireEvent.click(screen.getByRole('tab', { name: 'Biên bản hiện trường' }));
    await screen.findByText('Dự án ACTIVE');
    const activeCallsBeforeSubmit = mockFetchApi.mock.calls.filter(([url]) => String(url).includes('/auditor/active-projects')).length;

    fireEvent.click(screen.getByRole('button', { name: 'Gửi biên bản một lần' }));

    await waitFor(() => expect(mockFetchApi.mock.calls.filter(([url]) => String(url).includes('/auditor/active-projects')).length).toBe(activeCallsBeforeSubmit + 1));
  });

  it('làm mới phiên và thử lại request khi endpoint Auditor trả 401', async () => {
    mockFetchApi
      .mockRejectedValueOnce({ statusCode: 401 })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    render(<AuditorPortalClient />);

    await waitFor(() => expect(mockRefreshAuthSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledTimes(2));
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('làm mới phiên khi proxy trả 500 nhưng payload là UNAUTHENTICATED', async () => {
    mockFetchApi
      .mockRejectedValueOnce({ statusCode: 500, errorCode: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    render(<AuditorPortalClient />);

    await waitFor(() => expect(mockRefreshAuthSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledTimes(2));
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('đi tới đăng nhập khi refresh phiên bị từ chối', async () => {
    mockRefreshAuthSession.mockResolvedValue({ status: 'REJECTED', accessToken: '' });
    mockFetchApi.mockRejectedValueOnce({ statusCode: 401 }).mockResolvedValue({ data: [] });

    render(<AuditorPortalClient />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Không thể tải danh sách dự án niêm yết.')).not.toBeInTheDocument();
  });

  it('hiển thị thông báo riêng khi refresh bị giới hạn', async () => {
    mockRefreshAuthSession.mockResolvedValue({ status: 'RATE_LIMITED', accessToken: '' });
    mockFetchApi.mockRejectedValueOnce({ statusCode: 401 });

    render(<AuditorPortalClient />);

    expect(await screen.findByText('Hệ thống đang giới hạn tần suất xác thực. Vui lòng thử lại sau ít phút.')).toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('giữ thông báo lỗi 500 như luồng tải dữ liệu trước đó', async () => {
    mockFetchApi.mockRejectedValueOnce({ message: 'Lỗi máy chủ', statusCode: 500 });

    render(<AuditorPortalClient />);

    expect(await screen.findByText('Lỗi máy chủ')).toBeInTheDocument();
    expect(mockRefreshAuthSession).not.toHaveBeenCalled();
  });

  it('đi tới đăng nhập khi không còn session để refresh', async () => {
    mockRefreshAuthSession.mockResolvedValue({ status: 'MISSING_SESSION', accessToken: '' });
    mockFetchApi.mockRejectedValueOnce({ statusCode: 401 });

    render(<AuditorPortalClient />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/login'));
    expect(mockRefreshAuthSession).toHaveBeenCalledOnce();
  });

  it('hiển thị thông báo riêng khi server refresh tạm không khả dụng', async () => {
    mockRefreshAuthSession.mockResolvedValue({ status: 'UNAVAILABLE', accessToken: '' });
    mockFetchApi.mockRejectedValueOnce({ statusCode: 401 });

    render(<AuditorPortalClient />);

    expect(await screen.findByText('Chưa thể kết nối máy chủ để khôi phục phiên. Vui lòng thử lại.')).toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('giữ lỗi lần thử lại để luồng tải danh sách hiển thị fallback phù hợp', async () => {
    let pendingProjectsCallCount = 0;
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/auditor/pending-projects')) {
        pendingProjectsCallCount += 1;
        return pendingProjectsCallCount === 1
          ? Promise.reject({ statusCode: 401 })
          : Promise.reject({ statusCode: 503, message: 'Lỗi retry danh sách.' });
      }

      return Promise.resolve({ data: [] });
    });

    render(<AuditorPortalClient />);

    expect(await screen.findByText('Lỗi retry danh sách.')).toBeInTheDocument();
    expect(mockRefreshAuthSession).toHaveBeenCalledOnce();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
  it('does not reload ACTIVE projects when returning to an already loaded tab', async () => {
    render(<AuditorPortalClient />);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    await waitFor(() => expect(mockFetchApi.mock.calls.filter(([url]) => String(url).includes('/auditor/active-projects')).length).toBe(1));
    const activeCallsAfterFirstOpen = mockFetchApi.mock.calls.filter(([url]) => String(url).includes('/auditor/active-projects')).length;

    fireEvent.click(screen.getAllByRole('tab')[0]);
    fireEvent.click(screen.getAllByRole('tab')[1]);

    expect(mockFetchApi.mock.calls.filter(([url]) => String(url).includes('/auditor/active-projects')).length).toBe(activeCallsAfterFirstOpen);
  });

  it('opens the field-verification choices directly from a listed project', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/auditor/pending-projects')) {
        return Promise.resolve({ data: [{ projectId: 'project-1', name: 'Dự án cần xác minh', status: 'PENDING_ACTIVATION', activationEligibleAt: null, hasCurrentUserChallenged: false, hasCurrentUserVerified: false }] });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AuditorPortalClient />);

    const verificationButton = await screen.findByRole('button', { name: 'Chụp xác minh thực địa' });
    fireEvent.click(verificationButton);

    expect(screen.getByText('Listing verification form')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Gửi khiếu nại/i })).not.toBeInTheDocument();
  });

  it('hides the submit action after the Auditor already confirmed a listing', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/auditor/pending-projects')) {
        return Promise.resolve({ data: [{ projectId: 'project-1', name: 'Dự án đã xác minh', status: 'PENDING_ACTIVATION', activationEligibleAt: null, hasCurrentUserChallenged: false, hasCurrentUserVerified: true }] });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AuditorPortalClient />);

    expect(await screen.findByText('Bạn đã gửi kết quả xác minh cho dự án này.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chụp xác minh thực địa' })).not.toBeInTheDocument();
  });

  it('redirects a non-auditor session to unauthorized', async () => {
    mockSession.userRole = 'donor';

    render(<AuditorPortalClient />);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/unauthorized'));
  });

  it('clears the Auditor session and redirects to login when logging out', async () => {
    render(<AuditorPortalClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    const confirmationDialog = screen.getByRole('dialog', { name: 'Xác nhận đăng xuất' });
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Đăng xuất' }));

    expect(mockClearAuthSession).toHaveBeenCalledOnce();
    expect(mockRouterReplace).toHaveBeenCalledWith('/login');
  });

  it('logs out from the mobile Auditor drawer', async () => {
    render(<AuditorPortalClient />);

    fireEvent.click(screen.getByRole('button', { name: 'Mở menu' }));
    const mobileMenu = screen.getByRole('dialog', { name: 'Menu nghiệp vụ Auditor' });
    fireEvent.click(within(mobileMenu).getByRole('button', { name: 'Đăng xuất' }));
    const confirmationDialog = screen.getByRole('dialog', { name: 'Xác nhận đăng xuất' });
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Đăng xuất' }));

    expect(mockClearAuthSession).toHaveBeenCalledOnce();
    expect(mockRouterReplace).toHaveBeenCalledWith('/login');
  });

  it('opens the stake tab after the PayOS portal callback', async () => {
    window.history.replaceState({}, '', '/auditor?paymentFlow=auditor_portal&orderCode=1787650889515545');

    render(<AuditorPortalClient />);

    expect(await screen.findByRole('tab', { name: 'Cọc & Tài khoản nhận tiền' })).toHaveAttribute('aria-selected', 'true');
  });
});
