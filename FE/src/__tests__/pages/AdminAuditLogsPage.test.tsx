import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

import AuditLogsPageClient from '@/app/admin/audit-logs/AuditLogsPageClient';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AuditLogsPageClient /></QueryClientProvider>);
}

describe('AdminAuditLogsPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-1', userRole: 'admin' });
    mocks.fetchApi.mockResolvedValue({
      success: true,
      message: 'ok',
      data: {
        items: [{
          actionId: 'action-1',
          actionType: 'MANUAL_REJECT',
          adminId: 'admin-1',
          adminRole: 'admin',
          targetId: 'request-1',
          targetType: 'DISBURSEMENT_REQUEST',
          reason: 'Thiếu chứng từ',
          ipAddress: '10.0.0.1',
          userAgent: 'Mozilla/Test',
          requiresEscalation: false,
          context: {
            requestId: 'request-1',
            secretToken: 'must-not-render',
            previousError: { message: 'provider failed', access_token: 'nested-secret' }
          },
          createdAt: '2026-08-12T02:00:00.000Z'
        }],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1
      }
    });
  });

  it('fetches only for an admin and renders safe audit data', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      expect.stringContaining('/api/audit-logs?page=1&limit=20'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token-1' } })
    );
    expect(screen.getAllByText('request-1').length).toBeGreaterThan(0);
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('nested-secret')).not.toBeInTheDocument();
  });

  it('redirects unauthenticated and non-admin sessions without fetching', async () => {
    mocks.readAuthSession.mockReturnValueOnce({ accessToken: '', userRole: '' });
    const firstRender = renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    firstRender.unmount();

    mocks.replace.mockClear();
    mocks.fetchApi.mockClear();
    mocks.readAuthSession.mockReturnValueOnce({ accessToken: 'token-2', userRole: 'operator' });
    renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/unauthorized'));
    mocks.fetchApi.mockClear();
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('hydrates applied filters and page from URL state', async () => {
    mocks.searchParams = new URLSearchParams({ page: '2', actionType: 'FEEDBACK_FLAG', adminId: 'admin-2' });
    renderPage();

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      expect.stringContaining('/api/audit-logs?page=2&limit=20&actionType=FEEDBACK_FLAG&adminId=admin-2'),
      expect.anything()
    ));
  });

  it('shows API error and can apply a server-side action filter', async () => {
    mocks.fetchApi.mockRejectedValueOnce({ message: 'Audit API unavailable', statusCode: 503 });
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Audit API unavailable'));

    mocks.fetchApi.mockResolvedValueOnce({
      success: true,
      message: 'ok',
      data: { items: [], page: 1, limit: 20, total: 0, totalPages: 0 }
    });
    fireEvent.change(screen.getByLabelText('Lọc theo action'), { target: { value: 'FEEDBACK_FLAG' } });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }));
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenLastCalledWith(
      expect.stringContaining('actionType=FEEDBACK_FLAG'),
      expect.anything()
    ));
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.stringContaining('actionType=FEEDBACK_FLAG'),
      { scroll: false }
    );
  });

  it('supports next/previous pagination and keeps filters in the URL', async () => {
    mocks.fetchApi.mockResolvedValue({
      success: true,
      message: 'ok',
      data: { items: [], page: 1, limit: 20, total: 21, totalPages: 2 }
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sau' }));
    expect(mocks.replace).toHaveBeenCalledWith('/admin/audit-logs?page=2&limit=20', { scroll: false });
  });

  it('clamps an out-of-range deep-link to the last available page', async () => {
    mocks.searchParams = new URLSearchParams({ page: '10000' });
    mocks.fetchApi.mockResolvedValue({
      success: true,
      message: 'ok',
      data: { items: [], page: 10000, limit: 20, total: 21, totalPages: 2 }
    });
    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      '/admin/audit-logs?page=2&limit=20',
      { scroll: false }
    ));
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/audit-logs?page=2&limit=20'),
      expect.anything()
    ));
  });

  it('shows an explicit empty state when the server returns no canonical records', async () => {
    mocks.fetchApi.mockResolvedValue({
      success: true,
      message: 'ok',
      data: { items: [], page: 1, limit: 20, total: 0, totalPages: 0 }
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Không có audit log phù hợp với bộ lọc.')).toBeInTheDocument());
    expect(screen.getByText('0 bản ghi')).toBeInTheDocument();
  });
});
