import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';
import TransferStatusPanel from '@/app/components/adminTransfers/TransferStatusPanel';
import { useManualReviewQueue, useManualReviewQueueCounts } from '@/app/hooks/useManualReviewQueue';
import type { TransferSocketEvent } from '@/app/hooks/useTransferSocket';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

const routerPushMock = vi.hoisted(() => vi.fn());
const socketOptions = vi.hoisted(() => ({
  current: null as {
    onEvent: (event: TransferSocketEvent) => void;
    onPollTick?: () => void;
    onReconnect?: () => void;
  } | null
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock, replace: vi.fn() })
}));

vi.mock('@/app/hooks/useTransferSocket', () => ({
  useTransferSocket: vi.fn((options) => {
    socketOptions.current = options;
    return { isConnected: true, isUsingFallback: false };
  })
}));

vi.mock('@/app/hooks/useManualReviewQueue', () => ({
  useManualReviewQueue: vi.fn(),
  useManualReviewQueueCounts: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

/** Tạo item tối thiểu đủ để render row desktop/mobile của dashboard. */
function createItem(index: number, requestMode: 'NORMAL' | 'EMERGENCY' = 'NORMAL') {
  return {
    queueId: `MRQ-${index}`,
    requestId: `DS-${index}`,
    projectId: `project-${index}`,
    organizationId: 'org-001',
    amount: 1000,
    requestMode,
    emergencyReason: null,
    payosTransferStatus: 'MANUAL_REVIEW' as const,
    payosTransferAttemptCount: 2,
    payosTransferLastError: null,
    reviewCycle: 1,
    assignedAdminId: 'admin-001',
    assignmentMethod: 'ROUND_ROBIN' as const,
    slaDeadline: '2020-08-08T00:00:00.000Z',
    escalatedAt: null,
    updatedAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    nextRetryAt: null
  };
}

/** Tạo QueryClient wrapper cho component có invalidateQueries khi click action. */
function renderPanel(props: ComponentProps<typeof TransferStatusPanel> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<TransferStatusPanel {...props} />, { wrapper });
}

describe('TransferStatusPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketOptions.current = null;
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001' });
    vi.mocked(useManualReviewQueue).mockImplementation((params) => {
      const isPageQuery = params.limit === 50;
      const total = params.requestMode === 'EMERGENCY'
        ? 60
        : params.requestMode === 'NORMAL'
          ? 60
          : params.overdueOnly
            ? 10
            : 120;
      return {
        data: {
          items: isPageQuery ? Array.from({ length: Math.min(50, total) }, (_, index) => createItem(index, params.requestMode === 'EMERGENCY' ? 'EMERGENCY' : 'NORMAL')) : [],
          total,
          page: params.page,
          limit: params.limit,
          totalPages: Math.ceil(total / params.limit)
        },
        isPending: false,
        isError: false,
        error: null,
        refetch: vi.fn()
      } as never;
    });
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: { all: 120, emergency: 60, normal: 60, overdue: 10 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);
  });

  it('dùng một query list và một aggregate count query cho mỗi lần render dashboard', () => {
    renderPanel();

    expect(useManualReviewQueue).toHaveBeenCalledWith({ page: 1, limit: 50 });
    expect(useManualReviewQueueCounts).toHaveBeenCalledTimes(1);
  });

  it('phân trang thật và badge EMERGENCY lấy từ total server', () => {
    renderPanel();
    expect(screen.getByText('Trang 1/3 · 120 items')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Khẩn cấp/ })).toHaveTextContent('60');
    expect(screen.getByRole('alert')).toHaveTextContent('60 giao dịch EMERGENCY');

    fireEvent.click(screen.getByRole('button', { name: 'Sau →' }));
    expect(useManualReviewQueue).toHaveBeenCalledWith({ page: 2, limit: 50 });
    expect(screen.getByText('Trang 2/3 · 120 items')).toBeInTheDocument();
  });

  it('đổi tab reset page, gửi filter server và phân biệt empty queue với empty tab', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: /Khẩn cấp/ }));
    expect(useManualReviewQueue).toHaveBeenCalledWith({ page: 1, limit: 50, requestMode: 'EMERGENCY' });

    fireEvent.click(screen.getByRole('tab', { name: /Thường/ }));
    expect(useManualReviewQueue).toHaveBeenCalledWith({ page: 1, limit: 50, requestMode: 'NORMAL' });

    vi.mocked(useManualReviewQueue).mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 50, totalPages: 0 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: { all: 0, emergency: 0, normal: 0, overdue: 0 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);
    renderPanel();
    expect(screen.getAllByText('Queue đang rỗng.').length).toBeGreaterThan(0);
  });

  it('hiển thị empty tab riêng khi queue tổng vẫn còn item', () => {
    vi.mocked(useManualReviewQueue).mockImplementation((params) => {
      const isActiveQuery = params.limit === 50;
      return {
        data: {
          items: isActiveQuery ? [] : [],
          total: 0,
          page: params.page,
          limit: params.limit,
          totalPages: 0
        },
        isPending: false,
        isError: false,
        error: null,
        refetch: vi.fn()
      } as never;
    });
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: { all: 4, emergency: 0, normal: 0, overdue: 0 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);

    renderPanel();
    expect(screen.getAllByText('Tab này không có giao dịch phù hợp.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
  });

  it('reset page khi đổi tab và không render action cho status không còn MANUAL_REVIEW', () => {
    vi.mocked(useManualReviewQueue).mockImplementation((params) => ({
      data: {
        items: params.limit === 50 ? [{ ...createItem(1), payosTransferStatus: 'PROCESSING' as const }] : [],
        total: 51,
        page: params.page,
        limit: params.limit,
        totalPages: Math.ceil(51 / params.limit)
      },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never));

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Sau →' }));
    fireEvent.click(screen.getByRole('tab', { name: /Khẩn cấp/ }));
    expect(useManualReviewQueue).toHaveBeenCalledWith({ page: 1, limit: 50, requestMode: 'EMERGENCY' });
    expect(screen.queryByRole('button', { name: /Approve DS-1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'DS-1' })[0]).toHaveAttribute('href', '/admin/transfers/DS-1');
  });

  it('surface realtime events, reconnect polling và chuyển forbidden về unauthorized', () => {
    const onPushToast = vi.fn();
    renderPanel({ onPushToast });
    expect(socketOptions.current).not.toBeNull();

    socketOptions.current?.onEvent({
      type: 'transfer:manual-review-required',
      requestId: 'DS-NEW',
      projectId: 'project-001',
      amount: 1000,
      timestamp: '2026-08-08T00:00:00.000Z'
    });
    socketOptions.current?.onEvent({
      type: 'transfer:escalation-alert',
      requestId: 'DS-OVERDUE',
      timestamp: '2026-08-08T00:00:00.000Z'
    });
    socketOptions.current?.onEvent({
      type: 'transfer:updated',
      requestId: 'DS-DONE',
      payosTransferStatus: 'SUCCESS',
      updatedAt: '2026-08-08T00:00:00.000Z'
    });

    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ titleText: 'Transfer mới cần xử lý' }));
    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ titleText: 'Manual review đã quá SLA' }));
    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ titleText: 'Queue item đã thay đổi' }));

    vi.mocked(useManualReviewQueue).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { kind: 'FORBIDDEN', message: 'forbidden' } as never,
      refetch: vi.fn()
    } as never);
    renderPanel();
    expect(routerPushMock).toHaveBeenCalledWith('/unauthorized');
  });

  it('hiển thị lỗi network và cho phép refetch thủ công', () => {
    const refetch = vi.fn();
    vi.mocked(useManualReviewQueue).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { kind: 'NETWORK', message: 'network down' } as never,
      refetch
    } as never);
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: { all: 120, emergency: 0, normal: 120, overdue: 0 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);
    renderPanel();

    expect(screen.getByRole('alert')).toHaveTextContent('Không thể kết nối tới dịch vụ manual review.');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'RATE_LIMITED', message: 'rate limited' }, 'giới hạn tần suất đọc'],
    [{ kind: 'SERVER', message: 'server error' }, 'Không thể tải danh sách manual review']
  ])('hiển thị hướng dẫn cho lỗi query %s', (error, expectedMessage) => {
    vi.mocked(useManualReviewQueue).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: error as never,
      refetch: vi.fn()
    } as never);
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: { all: 120, emergency: 0, normal: 120, overdue: 0 },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never);
    renderPanel();

    expect(screen.getByRole('alert')).toHaveTextContent(expectedMessage);
  });

  it('render badge cho SUCCESS và FAILED theo status server, không suy đoán từ client', () => {
    vi.mocked(useManualReviewQueue).mockImplementation((params) => ({
      data: {
        items: params.limit === 50
          ? [
              { ...createItem(1), payosTransferStatus: 'SUCCESS' as const },
              { ...createItem(2), payosTransferStatus: 'FAILED' as const }
            ]
          : [],
        total: 2,
        page: params.page,
        limit: params.limit,
        totalPages: 1
      },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    } as never));
    renderPanel();

    expect(screen.getAllByText('Thành công').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Thất bại').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Approve DS-1/ })).not.toBeInTheDocument();
  });

  it('approve từ dialog gọi action và phát toast thành công sau response 202', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: { payosTransferStatus: 'PROCESSING' } } as never);
    const onPushToast = vi.fn();
    renderPanel({ onPushToast });

    fireEvent.click(screen.getByRole('button', { name: 'Approve DS-0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Approve' }));

    await waitFor(() => expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({
      titleText: 'Approve đã được chấp nhận',
      tone: 'success'
    })));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/DS-0/manual-approve',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('debounces burst realtime events into one queue invalidation', () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    try {
      renderPanel();
      socketOptions.current?.onEvent({
        type: 'transfer:manual-review-required',
        requestId: 'DS-NEW',
        projectId: 'project-001',
        amount: 1000,
        timestamp: '2026-08-08T00:00:00.000Z'
      });
      socketOptions.current?.onEvent({
        type: 'transfer:escalation-alert',
        requestId: 'DS-OVERDUE',
        timestamp: '2026-08-08T00:00:00.000Z'
      });
      socketOptions.current?.onEvent({
        type: 'transfer:updated',
        requestId: 'DS-DONE',
        payosTransferStatus: 'SUCCESS',
        updatedAt: '2026-08-08T00:00:00.000Z'
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(2_999));
      expect(invalidateSpy).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    } finally {
      invalidateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('surfaces aggregate count errors instead of silently showing zero totals', () => {
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { kind: 'RATE_LIMITED', message: 'rate limited' } as never,
      refetch: vi.fn()
    } as never);

    renderPanel();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Dashboard đang bị giới hạn tần suất đọc, vui lòng thử lại sau.');
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });

  it('redirects when the aggregate count query returns forbidden', async () => {
    vi.mocked(useManualReviewQueueCounts).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { kind: 'FORBIDDEN', message: 'forbidden' } as never,
      refetch: vi.fn()
    } as never);

    renderPanel();

    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/unauthorized'));
  });
});
