import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DLQManagement from '@/app/components/adminSbtRetry/DLQManagement';
import type { SbtDlqError, SbtDlqListResponse, SbtMintDlqEntry } from '@/app/types/sbtRetry';

const hookMocks = vi.hoisted(() => ({
  useList: vi.fn(),
  useRetry: vi.fn(),
  routerPush: vi.fn()
}));

vi.mock('@/app/hooks/useSbtDlqList', () => ({
  useSbtDlqList: hookMocks.useList,
  useRetrySbtMintJob: hookMocks.useRetry
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: hookMocks.routerPush })
}));

/** Tạo entry DLQ đầy đủ để test cả list, modal context và các nhánh escalation. */
function createEntry(overrides: Partial<SbtMintDlqEntry> = {}): SbtMintDlqEntry {
  return {
    dlqId: 'DLQ-1',
    mintRequestId: 'MINT-1',
    sbtId: 'SBT-1',
    projectId: 'PROJECT-1',
    projectName: 'Project One',
    organizationId: 'ORG-1',
    beneficiaryAddress: '0xbeneficiary',
    attemptNumber: 6,
    lastErrorMessage: 'RPC failed with a long reason',
    firstAttemptedAt: '2026-08-01T00:00:00.000Z',
    dlqAt: '2026-08-02T00:00:00.000Z',
    recoveredAt: null,
    recoveredBy: null,
    recoveryAttemptNumber: 0,
    status: 'OPEN',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides
  };
}

/** Tạo response mặc định và giữ các test component độc lập với query cache thật. */
function createListResponse(entries: SbtMintDlqEntry[]): SbtDlqListResponse {
  return {
    entries,
    pagination: { page: 1, limit: 20, total: entries.length, totalPages: Math.ceil(entries.length / 20) },
    openCount: entries.filter((entry) => entry.status === 'OPEN').length
  };
}

describe('DLQManagement', () => {
  let queryState: {
    data: SbtDlqListResponse | undefined;
    isPending: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
    error: SbtDlqError | null;
    refetch: ReturnType<typeof vi.fn>;
  };
  let mutationState: { isPending: boolean; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    queryState = {
      data: createListResponse([createEntry(), createEntry({ dlqId: 'DLQ-2', mintRequestId: 'MINT-2', projectId: 'PROJECT-2', projectName: null, lastErrorMessage: 'Second error' }), createEntry({ dlqId: 'DLQ-3', mintRequestId: 'MINT-3', projectId: 'PROJECT-3', projectName: 'Project Three', lastErrorMessage: 'Third error' })]),
      isPending: false,
      isFetching: false,
      isPlaceholderData: false,
      error: null,
      refetch: vi.fn()
    };
    mutationState = { isPending: false, mutate: vi.fn() };
    hookMocks.useList.mockImplementation(() => queryState);
    hookMocks.useRetry.mockImplementation(() => mutationState);
  });

  it('render đúng thứ tự API, fallback projectId, timestamp và retry count', () => {
    render(<DLQManagement />);

    expect(screen.getAllByText('Project One').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PROJECT-2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Second error').length).toBeGreaterThan(0);
    expect(screen.getAllByText('×6').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('sbt-dlq-row')).toHaveLength(3);
    expect(screen.getAllByTestId('sbt-dlq-row')[0]).toHaveTextContent('Project One');
    expect(screen.getAllByTestId('sbt-dlq-row')[1]).toHaveTextContent('PROJECT-2');
    expect(screen.getAllByTestId('sbt-dlq-card')).toHaveLength(3);
    expect(screen.getByRole('table')).toHaveClass('min-w-[760px]');
  });

  it('click Chạy lại chỉ mở pha confirm và chưa gọi mutation', () => {
    render(<DLQManagement />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);

    expect(screen.getByRole('dialog')).toHaveTextContent('Xác nhận chạy lại job');
    expect(mutationState.mutate).not.toHaveBeenCalled();
  });

  it('hiển thị skeleton khi query đang tải và empty state khi không có entry', () => {
    queryState = { ...queryState, data: undefined, isPending: true };
    const view = render(<DLQManagement />);
    expect(document.querySelectorAll('tr[aria-busy="true"]')).toHaveLength(4);

    queryState = { ...queryState, data: createListResponse([]), isPending: false };
    view.rerender(<DLQManagement />);
    expect(hookMocks.useList.mock.calls.some(([options]) => options?.page === 0)).toBe(false);
    expect(screen.getAllByText('Không có job nào trong tab này.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /bỏ qua/i }));
    view.rerender(<DLQManagement />);
    expect(screen.getAllByText(/đánh dấu bỏ qua/i).length).toBeGreaterThan(0);
  });

  it('hiển thị lỗi có nút thử lại và phân trang theo server response', () => {
    queryState = {
      ...queryState,
      error: { name: 'Error', message: 'Quá nhiều yêu cầu retry.', kind: 'RATE_LIMITED' },
      data: createListResponse([createEntry()])
    };
    queryState.data = {
      ...createListResponse([createEntry()]),
      pagination: { page: 1, limit: 20, total: 21, totalPages: 2 }
    };
    render(<DLQManagement />);

    expect(screen.getByRole('alert')).toHaveTextContent('Quá nhiều yêu cầu retry.');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(queryState.refetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sau →' }));
    expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2 });
  });

  it('enqueued true giữ dòng, bật in-flight và hiển thị badge đang chạy lại', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: true });
    });
    const onPushToast = vi.fn();
    render(<DLQManagement onPushToast={onPushToast} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

    await waitFor(() => expect(screen.getAllByText('Đang chạy lại').length).toBeGreaterThan(0));
    expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ isPollingEnabled: true });
    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'info' }));
  });

  it('enqueued false hiển thị warning và không bật polling', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: false });
    });
    const onPushToast = vi.fn();
    render(<DLQManagement onPushToast={onPushToast} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

    await waitFor(() => expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' })));
    expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ isPollingEnabled: false });
    expect(screen.queryByText('Đang chạy lại')).not.toBeInTheDocument();
  });

  it('dòng biến mất sau query settled thì mới báo success và tắt polling', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: true });
    });
    const onPushToast = vi.fn();
    const view = render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

    queryState = { ...queryState, data: createListResponse([]) };
    await act(async () => {
      view.rerender(<DLQManagement onPushToast={onPushToast} />);
    });

    await waitFor(() => expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' })));
    expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ isPollingEnabled: false });
  });

  it('does not report success while the query keeps placeholder data', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: true });
    });
    const onPushToast = vi.fn();
    const view = render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    onPushToast.mockClear();

    queryState = {
      ...queryState,
      data: createListResponse([]),
      isFetching: false,
      isPlaceholderData: true
    };
    await act(async () => {
      view.rerender(<DLQManagement onPushToast={onPushToast} />);
    });

    expect(onPushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ isPollingEnabled: true });
  });

  it('đổi tab khi in-flight không báo success giả do dòng của context cũ biến mất', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: true });
    });
    const onPushToast = vi.fn();
    const view = render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    onPushToast.mockClear();

    fireEvent.click(screen.getByRole('tab', { name: /Đã khôi phục/ }));
    queryState = { ...queryState, data: createListResponse([]) };
    await act(async () => {
      view.rerender(<DLQManagement onPushToast={onPushToast} />);
    });

    await waitFor(() => expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'RECOVERED', isPollingEnabled: false }));
    expect(onPushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('đổi trang khi in-flight cũng xóa tracking trước khi so sánh kết quả', async () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
      options.onSuccess({ enqueued: true });
    });
    const firstPage = createListResponse([createEntry()]);
    queryState = {
      ...queryState,
      data: {
        ...firstPage,
        pagination: { page: 1, limit: 20, total: 21, totalPages: 2 }
      }
    };
    const onPushToast = vi.fn();
    const view = render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    onPushToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /sau/i }));
    queryState = {
      ...queryState,
      data: {
        ...createListResponse([]),
        pagination: { page: 2, limit: 20, total: 21, totalPages: 2 }
      }
    };
    await act(async () => {
      view.rerender(<DLQManagement onPushToast={onPushToast} />);
    });

    await waitFor(() => expect(hookMocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2, isPollingEnabled: false }));
    expect(onPushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('409 refetch ngay, 429 giữ message BE và 403 redirect unauthorized', () => {
    const onPushToast = vi.fn();
    mutationState.mutate.mockImplementation((_id: string, options: { onError: (error: SbtDlqError) => void }) => {
      options.onError({ name: 'Error', message: 'Conflict from BE', kind: 'CONFLICT', statusCode: 409 });
    });
    render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    expect(queryState.refetch).toHaveBeenCalledTimes(1);
    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ bodyText: 'Conflict from BE', tone: 'error' }));

    vi.clearAllMocks();
    mutationState.mutate.mockImplementation((_id: string, options: { onError: (error: SbtDlqError) => void }) => {
      options.onError({ name: 'Error', message: 'Forbidden', kind: 'FORBIDDEN', statusCode: 403 });
    });
    render(<DLQManagement />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    expect(hookMocks.routerPush).toHaveBeenCalledWith('/unauthorized');
  });

  it('429 includes the BE message and shared IP quota context', () => {
    const onPushToast = vi.fn();
    mutationState.mutate.mockImplementation((_id: string, options: { onError: (error: SbtDlqError) => void }) => {
      options.onError({ name: 'Error', message: 'Quá nhiều yêu cầu retry.', kind: 'RATE_LIMITED', statusCode: 429 });
    });
    render(<DLQManagement onPushToast={onPushToast} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

    expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({
      bodyText: 'Quá nhiều yêu cầu retry. Hạn mức dùng chung theo IP.',
      tone: 'error'
    }));
  });

  it('RECOVERED không có nút Chạy lại và row cũ đủ ngày sẽ có cảnh báo', () => {
    queryState = {
      ...queryState,
      data: createListResponse([
        createEntry({ status: 'RECOVERED', dlqAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() })
      ])
    };
    render(<DLQManagement />);

    expect(screen.queryByRole('button', { name: 'Chạy lại' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Cảnh báo').length).toBeGreaterThan(0);
  });

  it('entry mới không bị gắn escalation badge', () => {
    queryState = {
      ...queryState,
      data: createListResponse([
        createEntry({ dlqAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), recoveryAttemptNumber: 0 })
      ])
    };
    render(<DLQManagement />);

    expect(screen.getAllByTestId('sbt-dlq-row')[0]).not.toHaveClass('bg-red-50/40');
    expect(screen.queryByText('Cảnh báo')).not.toBeInTheDocument();
  });

  it('watchdog hạ cờ sau thời gian chờ và báo worker vẫn đang chờ', async () => {
    vi.useFakeTimers();
    try {
      mutationState.mutate.mockImplementation((_id: string, options: { onSuccess: (result: { enqueued: boolean }) => void }) => {
        options.onSuccess({ enqueued: true });
      });
      const onPushToast = vi.fn();
      render(<DLQManagement onPushToast={onPushToast} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(onPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'info', titleText: 'Worker vẫn đang chờ' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('401 list error redirects to login', () => {
    queryState = {
      ...queryState,
      error: { name: 'Error', message: 'Token expired', kind: 'UNAUTHENTICATED', statusCode: 401 }
    };
    render(<DLQManagement />);

    expect(hookMocks.routerPush).toHaveBeenCalledWith('/login');
  });

  it('401 retry error redirects to login', () => {
    mutationState.mutate.mockImplementation((_id: string, options: { onError: (error: SbtDlqError) => void }) => {
      options.onError({ name: 'Error', message: 'Token expired', kind: 'UNAUTHENTICATED', statusCode: 401 });
    });
    render(<DLQManagement />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chạy lại' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));

    expect(hookMocks.routerPush).toHaveBeenCalledWith('/login');
  });
});
