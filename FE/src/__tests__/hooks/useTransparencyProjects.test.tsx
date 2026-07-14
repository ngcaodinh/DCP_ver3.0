/**
 * Tests cho useTransparencyProjects — D4.
 * Tập trung vào: đọc res.data (endpoint /donations/campaigns BỌC chuẩn {success, data},
 * khác các endpoint transparency), ánh xạ về {projectId, name}, xử lý data rỗng,
 * và logic retry (4xx không retry, 5xx retry 1 lần).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { useTransparencyProjects } from '@/app/hooks/useTransparencyProjects';

/** Render hook với QueryClientProvider; nhận client tùy biến để kiểm soát retry. */
function renderWithClient(
  hook: () => ReturnType<typeof useTransparencyProjects>,
  client: QueryClient
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

/** Client tắt retry cho các test không kiểm tra retry. */
function makeNoRetryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useTransparencyProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('đọc res.data và ánh xạ về {projectId, name} (bỏ trường thừa)', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: [
        { projectId: 'p1', name: 'Dự án A', goalAmount: 999, extra: 'bỏ' },
        { projectId: 'p2', name: 'Dự án B' },
      ],
    } as never);

    const { result } = renderWithClient(() => useTransparencyProjects(), makeNoRetryClient());

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data).toEqual([
      { projectId: 'p1', name: 'Dự án A' },
      { projectId: 'p2', name: 'Dự án B' },
    ]);
  });

  it('gọi đúng endpoint /donations/campaigns kèm limit', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: [] } as never);

    renderWithClient(() => useTransparencyProjects(), makeNoRetryClient());

    await waitFor(() => {
      expect(buildApiUrl).toHaveBeenCalledWith('/donations/campaigns?limit=100');
    });
  });

  it('data rỗng/undefined → trả mảng rỗng, không crash', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: undefined } as never);

    const { result } = renderWithClient(() => useTransparencyProjects(), makeNoRetryClient());

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data).toEqual([]);
  });

  it('lỗi 4xx (vd 404) → KHÔNG retry, chỉ gọi fetchApi 1 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' });

    const { result } = renderWithClient(() => useTransparencyProjects(), new QueryClient());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('lỗi 5xx (vd 503) → retry 1 lần, gọi fetchApi 2 lần', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 503, message: 'Unavailable', errorCode: 'UNAVAILABLE' });

    const { result } = renderWithClient(() => useTransparencyProjects(), new QueryClient());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    }, { timeout: 3000 });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
});
