import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  buildSbtDlqUrl,
  fetchSbtDlqList,
  mapSbtDlqError,
  useRetrySbtMintJob,
  useSbtDlqList
} from '@/app/hooks/useSbtDlqList';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type { SbtDlqListResponse } from '@/app/types/sbtRetry';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

const responseData: SbtDlqListResponse = {
  entries: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  openCount: 0
};

/** Tạo QueryClient độc lập cho mỗi test để không chia sẻ cache hoặc retry state. */
function createQueryWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Đọc refetchInterval đã resolve của query để kiểm tra polling mà không phụ thuộc timer thật. */
function getDlqRefetchInterval(queryClient: QueryClient): unknown {
  const query = queryClient.getQueryCache().find({ queryKey: ['sbtDlqList', { page: 1, status: 'OPEN' }] });
  return (query?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval;
}

describe('useSbtDlqList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001' });
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: responseData } as never);
  });

  it('xây URL đúng prefix API, limit cố định và status uppercase', () => {
    expect(buildSbtDlqUrl(2, 'OPEN')).toBe('/api/sbt/dlq?page=2&limit=20&status=OPEN');
  });

  it('gửi Authorization Bearer và giữ nguyên ngày dạng string từ API', async () => {
    const data = {
      ...responseData,
      entries: [{
        dlqId: 'DLQ-1',
        mintRequestId: 'MINT-1',
        sbtId: 'SBT-1',
        projectId: 'PROJECT-1',
        projectName: 'Project 1',
        organizationId: 'ORG-1',
        beneficiaryAddress: '0x1',
        attemptNumber: 6,
        lastErrorMessage: 'RPC failed',
        firstAttemptedAt: '2026-08-01T00:00:00.000Z',
        dlqAt: '2026-08-02T00:00:00.000Z',
        recoveredAt: null,
        recoveredBy: null,
        recoveryAttemptNumber: 0,
        status: 'OPEN' as const,
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z'
      }]
    };
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data } as never);

    await expect(fetchSbtDlqList(1, 'OPEN')).resolves.toEqual(data);
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/sbt/dlq?page=1&limit=20&status=OPEN',
      { headers: { Authorization: 'Bearer token-001' } }
    );
    expect(data.entries[0].dlqAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('map đúng 429/400 shape có error và lỗi không có statusCode', () => {
    const rateLimitError = mapSbtDlqError({ statusCode: 429, error: 'Quá nhiều yêu cầu retry.' });
    const validationError = mapSbtDlqError({ statusCode: 400, error: 'Validation failed.', validationErrors: [] });
    const networkError = mapSbtDlqError(new TypeError('Failed to fetch'));

    expect(rateLimitError).toMatchObject({ kind: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu retry.' });
    expect(validationError).toMatchObject({ kind: 'VALIDATION', message: 'Validation failed.' });
    expect(networkError).toMatchObject({ kind: 'NETWORK', message: 'Failed to fetch' });
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [400, 'VALIDATION'],
    [500, 'SERVER']
  ] as const)('map status %s thành kind %s', (statusCode, expectedKind) => {
    expect(mapSbtDlqError({ statusCode, message: 'API error' }).kind).toBe(expectedKind);
  });

  it('không retry lỗi 4xx nhưng retry một lần với lỗi 5xx', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 400, error: 'bad request' });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const query = renderHook(
      () => useSbtDlqList({ page: 1, status: 'OPEN', isPollingEnabled: false }),
      { wrapper: createQueryWrapper(client) }
    );
    await waitFor(() => expect(query.result.current.isError).toBe(true));
    expect(fetchApi).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.mocked(fetchApi)
      .mockRejectedValueOnce({ statusCode: 503, message: 'temporary failure' })
      .mockResolvedValueOnce({ success: true, message: '', data: responseData } as never);
    const retryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const retriedQuery = renderHook(
      () => useSbtDlqList({ page: 1, status: 'OPEN', isPollingEnabled: false }),
      { wrapper: createQueryWrapper(retryClient) }
    );
    await waitFor(() => expect(retriedQuery.result.current.data).toEqual(responseData));
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it('uses an empty bearer value when the session has no access token', async () => {
    vi.mocked(readAuthSession).mockReturnValue({});

    await fetchSbtDlqList(1, 'OPEN');

    expect(fetchApi).toHaveBeenCalledWith(
      '/api/sbt/dlq?page=1&limit=20&status=OPEN',
      { headers: { Authorization: 'Bearer ' } }
    );
  });

  it('maps 401 to UNAUTHENTICATED and preserves the fallback error message', () => {
    expect(mapSbtDlqError({ statusCode: 401, error: 'Access token expired' })).toMatchObject({
      kind: 'UNAUTHENTICATED',
      statusCode: 401,
      message: 'Access token expired'
    });
  });

  it.each([401, 403, 404, 409, 429])('does not retry 4xx status %s', async (statusCode) => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode, message: 'API error' });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const query = renderHook(
      () => useSbtDlqList({ page: 1, status: 'OPEN', isPollingEnabled: false }),
      { wrapper: createQueryWrapper(client) }
    );

    await waitFor(() => expect(query.result.current.isError).toBe(true));
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('chỉ cấu hình refetch interval khi in-flight polling được bật', async () => {
    const clientWithoutPolling = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryWithoutPolling = renderHook(
      () => useSbtDlqList({ page: 1, status: 'OPEN', isPollingEnabled: false }),
      { wrapper: createQueryWrapper(clientWithoutPolling) }
    );
    await waitFor(() => expect(queryWithoutPolling.result.current.data).toEqual(responseData));
    expect(getDlqRefetchInterval(clientWithoutPolling)).toBe(false);
    queryWithoutPolling.unmount();

    const clientWithPolling = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryWithPolling = renderHook(
      () => useSbtDlqList({ page: 1, status: 'OPEN', isPollingEnabled: true }),
      { wrapper: createQueryWrapper(clientWithPolling) }
    );
    await waitFor(() => expect(queryWithPolling.result.current.data).toEqual(responseData));
    expect(getDlqRefetchInterval(clientWithPolling)).toBe(10_000);
  });

  it('mutation thành công invalidate toàn bộ query sbtDlqList', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: { mintRequestId: 'MINT-1', sbtId: 'SBT-1', status: 'PENDING', attemptNumber: 0, enqueued: true }
    } as never);
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const mutation = renderHook(() => useRetrySbtMintJob(), { wrapper: createQueryWrapper(client) });

    await act(async () => {
      await mutation.result.current.mutateAsync('MINT-1');
    });

    expect(fetchApi).toHaveBeenCalledWith(
      '/api/sbt/retry-job/MINT-1',
      { method: 'POST', headers: { Authorization: 'Bearer token-001' } }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sbtDlqList'] });
  });
});
