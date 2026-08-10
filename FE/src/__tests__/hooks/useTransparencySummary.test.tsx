/**
 * Tests cho useTransparencySummary — D4.
 * Tập trung vào: cast envelope (đọc res chứ KHÔNG phải res.data vì endpoint trả
 * raw object), gate enabled khi chưa chọn dự án, và logic retry (4xx không retry,
 * 5xx retry 1 lần).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

import { fetchApi } from '@/app/utils/apiClient';
import { useTransparencySummary } from '@/app/hooks/useTransparencySummary';

/** Render hook với QueryClientProvider; nhận client tùy biến để kiểm soát retry. */
function renderWithClient(
  hook: () => ReturnType<typeof useTransparencySummary>,
  client: QueryClient
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(hook, { wrapper }) };
}

/** Envelope summary mẫu (raw object, KHÔNG bọc {success, data}). */
function makeSummaryEnvelope() {
  return {
    projectId: 'project-1',
    totalRaised: 1000000,
    totalDisbursed: 400000,
    remaining: 600000,
    donorCount: 12,
    transactionCount: 12,
    disbursementCount: 2,
    disbursedAmounts: [300000, 100000],
    excludedReorgedVnd: 0,
    excludedReorgedCount: 0,
    overDisbursed: false,
    cached: false,
    fallbackMode: false,
  };
}

type TransparencyPollingOptions = {
  refetchInterval?: unknown;
  refetchIntervalInBackground?: unknown;
};

/** Đọc cấu hình polling runtime mà public QueryOptions không khai báo trong kiểu TypeScript. */
function getPollingOptions(client: QueryClient): TransparencyPollingOptions {
  const query = client.getQueryCache().find({ queryKey: ['transparencySummary', 'project-1'] });
  return (query?.options ?? {}) as TransparencyPollingOptions;
}

describe('useTransparencySummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projectId undefined → query KHÔNG fetch (chưa chọn dự án)', async () => {
    const { result } = renderWithClient(
      () => useTransparencySummary(undefined),
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('cast envelope từ chính res (không phải res.data)', async () => {
    // fetchApi trả raw envelope trực tiếp — hook phải dùng res, res.data là undefined.
    vi.mocked(fetchApi).mockResolvedValue(makeSummaryEnvelope() as never);

    const { result } = renderWithClient(
      () => useTransparencySummary('project-1'),
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    );

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data?.totalRaised).toBe(1000000);
    expect(result.current.data?.remaining).toBe(600000);
  });

  it('cấu hình polling để dashboard đang mở nhận số liệu sau chu kỳ sync', async () => {
    vi.mocked(fetchApi).mockResolvedValue(makeSummaryEnvelope() as never);

    const { result, client } = renderWithClient(
      () => useTransparencySummary('project-1'),
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    );

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    const pollingOptions = getPollingOptions(client);
    expect(pollingOptions.refetchInterval).toBe(30_000);
    expect(pollingOptions.refetchIntervalInBackground).toBe(false);
  });

  it('lỗi 4xx (vd 404) → KHÔNG retry, chỉ gọi fetchApi 1 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' });

    const { result } = renderWithClient(() => useTransparencySummary('project-1'), new QueryClient());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('lỗi 5xx (vd 500) → retry 1 lần, gọi fetchApi 2 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 500, message: 'Server error', errorCode: 'INTERNAL' });

    const { result } = renderWithClient(() => useTransparencySummary('project-1'), new QueryClient());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    }, { timeout: 3000 });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
});
