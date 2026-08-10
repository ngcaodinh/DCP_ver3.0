/**
 * Tests cho useTransparencyTimeline — D4.
 * Tập trung vào: cast envelope (đọc res chứ KHÔNG phải res.data vì endpoint trả
 * raw object), phân trang qua nextCursor (getNextPageParam), và gate enabled
 * khi chưa chọn dự án.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

import { fetchApi } from '@/app/utils/apiClient';
import { useTransparencyTimeline } from '@/app/hooks/useTransparencyTimeline';

function renderWithQuery(hook: () => ReturnType<typeof useTransparencyTimeline>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(hook, { wrapper }) };
}

/** Envelope timeline mẫu (raw object, KHÔNG bọc {success, data}). */
function makeTimelineEnvelope(nextCursor: string | null) {
  return {
    timeline: [{ eventId: 'e1', correlationId: 'c1', eventType: 'DONATION' }],
    nextCursor,
    cached: false,
    grouped: {},
    count: 1,
    fallbackMode: false,
  };
}

describe('useTransparencyTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projectId undefined → query KHÔNG fetch (chưa chọn dự án)', async () => {
    const { result } = renderWithQuery(() => useTransparencyTimeline(undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('cast envelope từ chính res (không phải res.data) và đọc nextCursor', async () => {
    // fetchApi trả raw envelope trực tiếp — hook phải dùng res, res.data là undefined.
    vi.mocked(fetchApi).mockResolvedValue(makeTimelineEnvelope('cursor-2') as never);

    const { result } = renderWithQuery(() => useTransparencyTimeline('project-1'));

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data?.pages[0].timeline).toHaveLength(1);
    // Còn nextCursor → hasNextPage true
    expect(result.current.hasNextPage).toBe(true);
  });

  it('nextCursor null → hasNextPage false (hết trang)', async () => {
    vi.mocked(fetchApi).mockResolvedValue(makeTimelineEnvelope(null) as never);

    const { result } = renderWithQuery(() => useTransparencyTimeline('project-1'));

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('chỉ polling trang đầu và dừng sau khi người dùng xem thêm trang lịch sử', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce(makeTimelineEnvelope('cursor-2') as never)
      .mockResolvedValueOnce(makeTimelineEnvelope(null) as never);

    const { client, result } = renderWithQuery(() => useTransparencyTimeline('project-1'));

    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(1);
    });

    const query = client.getQueryCache().find({ queryKey: ['transparencyTimeline', 'project-1'] });
    if (!query) throw new Error('Thiếu transparency timeline query trong cache test.');

    const refetchInterval = (query.options as {
      refetchInterval?: (currentQuery: typeof query) => number | false;
    }).refetchInterval;
    expect(refetchInterval?.(query)).toBe(30_000);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(2);
    });

    expect(refetchInterval?.(query)).toBe(false);
  });

  it('lỗi 4xx (vd 400) → KHÔNG retry, chỉ gọi fetchApi 1 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 400, message: 'Bad request', errorCode: 'VALIDATION_ERROR' });

    // Dùng client mặc định (retry theo hook) thay vì tắt retry ở wrapper để verify đúng logic hook.
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTransparencyTimeline('project-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('lỗi 5xx (vd 500) → retry 1 lần, gọi fetchApi 2 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 500, message: 'Server error', errorCode: 'INTERNAL' });

    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTransparencyTimeline('project-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    }, { timeout: 3000 });
    // Lần đầu + 1 retry (failureCount < 1) = 2 lần gọi.
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
});
