import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi, mockRefreshAuthSession, mockRouterReplace } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockRefreshAuthSession: vi.fn(),
  mockRouterReplace: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockRouterReplace }) }));
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, fetchApi: mockFetchApi }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'auditor-token' }) }));
vi.mock('@/app/utils/authSessionRefresh', () => ({ refreshAuthSession: mockRefreshAuthSession }));
vi.mock('@/app/components/common/evidenceCamera/EvidenceCameraCapture', () => ({
  EvidenceCameraCapture: () => <div data-testid="evidence-camera">camera</div>
}));
vi.mock('@/app/components/governance/AuditorFieldReportForm', () => ({
  default: ({ projects, onSubmitted }: { projects: Array<{ name: string }>; onSubmitted: () => Promise<void> }) => (
    <div><p>{projects[0]?.name || 'Không có dự án ACTIVE'}</p><button type="button" onClick={() => void onSubmitted()}>Gửi biên bản một lần</button></div>
  )
}));

import AuditorPortalClient from '@/app/components/governance/AuditorPortalClient';

describe('AuditorPortalClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshAuthSession.mockResolvedValue({ status: 'REFRESHED', accessToken: 'fresh-auditor-token' });
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/auditor/pending-projects')) return Promise.resolve({ data: [] });
      if (url.includes('/auditor/active-projects')) return Promise.resolve({ data: [{ projectId: 'active-1', name: 'Dự án ACTIVE', milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', description: 'Đối chiếu tạm ứng' }], fieldReport: null }] });
      return Promise.resolve({ data: {} });
    });
  });

  it('hiển thị hai tab và tải danh sách ACTIVE cho biên bản hiện trường', async () => {
    render(<AuditorPortalClient />);

    expect(screen.getByRole('tab', { name: 'Khiếu nại niêm yết' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Khiếu nại niêm yết' })).toHaveAttribute('aria-controls', 'auditor-challenges-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'Biên bản hiện trường' }));

    await waitFor(() => expect(screen.getByText('Dự án ACTIVE')).toBeInTheDocument());
    expect(screen.getByRole('tabpanel', { name: 'Biên bản hiện trường' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Biên bản hiện trường' })).toHaveAttribute('aria-labelledby', 'auditor-field-reports-tab');
    expect(mockFetchApi).toHaveBeenCalledWith('/api/project-governance/auditor/active-projects', expect.objectContaining({ headers: { Authorization: 'Bearer auditor-token' } }));
  });

  it('điều hướng đến dự án ACTIVE khi không có dự án trong cửa sổ khiếu nại', async () => {
    render(<AuditorPortalClient />);

    expect(await screen.findByText('Chưa có dự án trong cửa sổ rà soát')).toBeInTheDocument();
    expect(screen.getByText('Chỉ dự án đã được duyệt và đang niêm yết hoặc tranh chấp mới xuất hiện tại đây. Dự án ACTIVE được kiểm tra trong mục Biên bản hiện trường.')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Xem 1 dự án ACTIVE' }));

    expect(screen.getByRole('tab', { name: 'Biên bản hiện trường' })).toHaveAttribute('aria-selected', 'true');
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
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledTimes(3));
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
});
