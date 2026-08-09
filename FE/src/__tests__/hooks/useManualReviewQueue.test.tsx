import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  buildManualReviewQueueQuery,
  fetchManualReviewQueue,
  fetchManualReviewQueueCounts,
  mapManualReviewQueueError,
  useManualReviewQueue
} from '@/app/hooks/useManualReviewQueue';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

/** Tạo wrapper QueryClient độc lập để test không chia sẻ cache giữa các case. */
function createQueryWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  /** Wrapper có tên để React DevTools/lint nhận diện rõ provider của từng test. */
  function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return QueryWrapper;
}

describe('useManualReviewQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001' });
  });

  it('gửi pagination và filter server đúng query string, giữ total từ response', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: { items: [], total: 60, page: 2, limit: 50, totalPages: 2 }
    } as never);

    const { result } = renderHook(
      () => useManualReviewQueue({ page: 2, limit: 50, requestMode: 'EMERGENCY', overdueOnly: true }),
      { wrapper: createQueryWrapper() }
    );

    await waitFor(() => expect(result.current.data?.total).toBe(60));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/pending-review?page=2&limit=50&requestMode=EMERGENCY&overdueOnly=true',
      { headers: { Authorization: 'Bearer token-001' } }
    );
  });

  it('phân biệt 401 thành UNAUTHENTICATED và không retry lỗi 4xx', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 401, errorCode: 'UNAUTHORIZED', message: 'expired' });

    const { result } = renderHook(
      () => useManualReviewQueue({ page: 1, limit: 50 }),
      { wrapper: createQueryWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.kind).toBe('UNAUTHENTICATED');
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('tải aggregate counts bằng một endpoint riêng', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: { all: 12, emergency: 3, normal: 9, overdue: 2 }
    } as never);

    await expect(fetchManualReviewQueueCounts()).resolves.toEqual({
      all: 12,
      emergency: 3,
      normal: 9,
      overdue: 2
    });
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/pending-review/counts',
      { headers: { Authorization: 'Bearer token-001' } }
    );
  });

  it.each([
    [{ statusCode: 403, errorCode: 'FORBIDDEN', message: 'forbidden' }, 'FORBIDDEN'],
    [{ statusCode: 429, errorCode: 'RATE_LIMITED', message: 'slow down' }, 'RATE_LIMITED']
  ])('phân biệt lỗi %s để UI không gộp chung lỗi mạng', async (error, expectedKind) => {
    vi.mocked(fetchApi).mockRejectedValue(error);

    const { result } = renderHook(
      () => useManualReviewQueue({ page: 1, limit: 1, overdueOnly: true }),
      { wrapper: createQueryWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.kind).toBe(expectedKind);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('bỏ filter false khỏi query string và map đầy đủ nhóm lỗi HTTP/network', () => {
    expect(buildManualReviewQueueQuery({ page: 1, limit: 50, overdueOnly: false })).toBe('page=1&limit=50');
    expect(mapManualReviewQueueError({ statusCode: 403, errorCode: 'FORBIDDEN', message: 'forbidden' }).kind).toBe('FORBIDDEN');
    expect(mapManualReviewQueueError({ statusCode: 400, message: 'bad request' }).kind).toBe('SERVER');
    expect(mapManualReviewQueueError({ statusCode: 500, message: 'server down' }).kind).toBe('SERVER');
    expect(mapManualReviewQueueError(new Error('network down'))).toMatchObject({
      kind: 'NETWORK',
      message: 'network down'
    });
  });

  it('retry network đúng một lần rồi trả dữ liệu nếu request kế tiếp thành công', async () => {
    vi.mocked(fetchApi)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        success: true,
        message: '',
        data: { items: [], total: 0, page: 1, limit: 50, totalPages: 0 }
      } as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: true, retryDelay: 0 } }
    });
    function RetryQueryWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(
      () => useManualReviewQueue({ page: 1, limit: 50 }),
      { wrapper: RetryQueryWrapper }
    );

    await waitFor(() => expect(result.current.data?.total).toBe(0));
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it('đọc access token tại thời điểm fetch và giữ errorCode từ API', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'fresh-token' });
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 503, errorCode: 'SERVICE_UNAVAILABLE', message: 'maintenance' });

    await expect(fetchManualReviewQueue({ page: 1, limit: 50 })).rejects.toMatchObject({
      kind: 'SERVER',
      statusCode: 503,
      errorCode: 'SERVICE_UNAVAILABLE',
      message: 'maintenance'
    });
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/pending-review?page=1&limit=50',
      { headers: { Authorization: 'Bearer fresh-token' } }
    );
  });
});
