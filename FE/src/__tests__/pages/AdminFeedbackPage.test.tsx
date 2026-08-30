import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import FeedbackFlaggingPageClient from '@/app/admin/feedback/FeedbackFlaggingPageClient';

function renderPage({ embedded = false }: { embedded?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><FeedbackFlaggingPageClient embedded={embedded} /></QueryClientProvider>);
}

function successResponse() {
  return {
    success: true,
    message: 'ok',
    data: {
      items: [{
        feedbackId: 'fb-1',
        projectId: 'project-1',
        projectName: 'Project 1',
        rating: 5,
        comment: 'Nội dung feedback',
        submittedAt: '2026-08-10T03:12:00.000Z',
        riskScore: 9,
        isFlagged: true,
        source: 'public',
        flagReason: { kind: 'AUTO', indicators: ['extreme_rating:5'], adminReason: null, flaggedByAdminId: null, flaggedAt: null }
      }],
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1
    }
  };
}

describe('AdminFeedbackPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-1', userRole: 'admin' });
    mocks.fetchApi.mockResolvedValue(successResponse());
  });

  it('admin fetches after auth and sends deletionState/page URL contract', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    expect(mocks.fetchApi).toHaveBeenCalledWith(
      expect.stringContaining('/api/feedback/flagged?page=1&limit=20&deletionState=active'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token-1' } })
    );
    expect(screen.getByText('Project 1')).toBeInTheDocument();
    expect(screen.getByText('Rủi ro cao')).toBeInTheDocument();
  });

  it('redirects unauthenticated/non-admin before any flagged request', async () => {
    mocks.readAuthSession.mockReset();
    mocks.fetchApi.mockClear();
    mocks.readAuthSession.mockReturnValue({ accessToken: '', userRole: '' });
    const unauthenticatedRender = renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    unauthenticatedRender.unmount();
    expect(mocks.fetchApi).not.toHaveBeenCalled();

    mocks.replace.mockClear();
    mocks.fetchApi.mockClear();
    mocks.readAuthSession.mockReset();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'token-2', userRole: 'operator' });
    renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/unauthorized'));
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('switches deleted tab and keeps deletionState in URL', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Đã xoá' }));

    expect(mocks.replace).toHaveBeenCalledWith('/admin/feedback?page=1&limit=20&deletionState=deleted', { scroll: false });
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenLastCalledWith(
      expect.stringContaining('deletionState=deleted'),
      expect.anything()
    ));
  });

  it('normalizes a deep-linked page to 1 when the selected tab is empty', async () => {
    mocks.searchParams = new URLSearchParams({ page: '999' });
    mocks.fetchApi.mockResolvedValueOnce({
      ...successResponse(),
      data: { items: [], page: 999, limit: 20, total: 0, totalPages: 0 }
    });

    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      '/admin/feedback?page=1&limit=20&deletionState=active',
      { scroll: false }
    ));
  });

  it('does not replace the Admin shell URL when embedded feedback changes tab', async () => {
    renderPage({ embedded: true });
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Đã xoá' }));

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Feedback Flagging Panel' })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenLastCalledWith(
      expect.stringContaining('deletionState=deleted'),
      expect.anything()
    ));
  });
});
