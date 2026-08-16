import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
  readAuthSession: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession }));
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: mocks.buildApiUrl, fetchApi: mocks.fetchApi }));
vi.mock('@/app/components/systemAdmin/tailwind/ToastStack', () => ({
  default: ({ toastItemList }: { toastItemList: Array<{ titleText: string; bodyText: string }> }) => (
    <div>{toastItemList.map(toast => <p key={`${toast.titleText}-${toast.bodyText}`}>{toast.titleText}: {toast.bodyText}</p>)}</div>
  )
}));

import OrganizationFeedbackPageClient from '@/app/organization/feedback/OrganizationFeedbackPageClient';

function response(overrides: Partial<{
  items: Array<Record<string, unknown>>;
  total: number;
  totalPages: number;
  page: number;
}> = {}) {
  return {
    success: true,
    message: 'ok',
    data: {
      items: overrides.items ?? [{
        feedbackId: 'FB-1', projectId: 'DA-1', projectName: 'Dự án 1', rating: 5,
        comment: 'Nội dung', submittedAt: '2026-08-01T00:00:00Z', source: 'batch', isFlagged: false
      }],
      page: overrides.page ?? 1,
      limit: 20,
      total: overrides.total ?? 1,
      totalPages: overrides.totalPages ?? 1,
      stats: { totalCount: overrides.total ?? 1, visibleCount: overrides.total ?? 1, pendingCount: 0, avgRating: 5, distribution: { '5': overrides.total ?? 1 } }
    }
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><OrganizationFeedbackPageClient /></QueryClientProvider>);
}

describe('OrganizationFeedbackPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-1', userRole: 'organizations' });
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      return Promise.resolve(url === '/projects' ? { success: true, message: 'ok', data: [{ projectId: 'DA-1', name: 'Dự án 1' }] } : response());
    });
  });

  it('chấp nhận cả hai role organization và chỉ fetch sau auth gate', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(mocks.fetchApi).toHaveBeenCalledWith(expect.stringContaining('/api/feedback/organization'), expect.anything());

    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-2', userRole: 'organization' });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('table').length).toBeGreaterThan(1));
  });

  it('redirect login hoặc unauthorized trước khi gọi API', async () => {
    mocks.readAuthSession.mockReturnValue({ accessToken: '', userRole: '' });
    renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.fetchApi).not.toHaveBeenCalled();

    mocks.replace.mockClear();
    mocks.fetchApi.mockClear();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-2', userRole: 'donor' });
    renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/unauthorized'));
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('đổi filter, giữ filter trong URL và phân biệt empty state có filter', async () => {
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      return Promise.resolve(response({ items: [], total: 0, totalPages: 0 }));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Chưa có phản hồi nào')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Lọc theo trạng thái moderation'), { target: { value: 'pending' } });

    expect(mocks.replace).toHaveBeenCalledWith('/organization/feedback?page=1&limit=20&moderationState=pending', { scroll: false });
    await waitFor(() => expect(screen.getByText('Không có phản hồi phù hợp bộ lọc.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Xóa bộ lọc' })).toBeInTheDocument();
  });

  it('xuất tối đa 2000 dòng và cảnh báo khi vượt 20 trang', async () => {
    const listResponse = response({ total: 2001, totalPages: 21 });
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      return Promise.resolve(listResponse);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Xuất CSV' }));

    await waitFor(() => expect(screen.getByText(/Chỉ xuất 2000 dòng đầu tiên/)).toBeInTheDocument());
    expect(mocks.fetchApi.mock.calls.filter(call => String(call[0]).includes('limit=100')).length).toBe(20);
  });

  it('chỉ tải đúng số trang theo limit export khi tổng dữ liệu dưới 2000', async () => {
    const listResponse = response({ total: 500, totalPages: 25 });
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      return Promise.resolve(listResponse);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Xuất CSV' }));

    await waitFor(() => expect(mocks.fetchApi.mock.calls.filter(call => String(call[0]).includes('limit=100')).length).toBe(5));
    expect(screen.queryByText(/Chỉ xuất 2000 dòng đầu tiên/)).not.toBeInTheDocument();
  });

  it('giữ file đã gom được khi export bị rate limit giữa chừng', async () => {
    const listResponse = response({ total: 500, totalPages: 25 });
    let exportCallCount = 0;
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      if (url.includes('limit=100')) {
        exportCallCount += 1;
        if (exportCallCount === 2) return Promise.reject({ statusCode: 429, message: 'rate limited' });
      }
      return Promise.resolve(listResponse);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Xuất CSV' }));

    await waitFor(() => expect(screen.getByText(/Đã tải được 1 dòng trước khi chạm giới hạn/)).toBeInTheDocument());
    expect(screen.queryByText(/Xuất CSV thất bại/)).not.toBeInTheDocument();
  });

  it('không điều hướng khỏi trang khi chỉ query danh sách dự án bị 403', async () => {
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.reject({ statusCode: 403, message: 'inactive account' });
      return Promise.resolve(response());
    });

    renderPage();

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(mocks.replace).not.toHaveBeenCalledWith('/unauthorized');
    expect(screen.getByText(/Không thể tải danh sách dự án/)).toBeInTheDocument();
  });

  it('chuẩn hóa deep-link page vượt tổng số trang về page cuối', async () => {
    mocks.searchParams = new URLSearchParams('page=999&limit=20&moderationState=all');
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      return Promise.resolve(response({ page: 2, total: 21, totalPages: 2 }));
    });

    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      '/organization/feedback?page=2&limit=20&moderationState=all',
      { scroll: false }
    ));
  });

  it('redirect login khi request list hết phiên sau khi auth gate đã pass', async () => {
    mocks.fetchApi.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/projects') return Promise.resolve({ success: true, message: 'ok', data: [] });
      return Promise.reject({ statusCode: 401, message: 'expired' });
    });

    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
  });
});
