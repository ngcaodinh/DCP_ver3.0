/**
 * Tests cho useOverrideRequests — B4.
 * Tập trung vào tham số `enabled` (gate refetchInterval khi drawer đóng — A3-fix)
 * và luồng fetch/mutation cơ bản.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
}));

import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { useOverrideRequests } from '@/app/hooks/useOverrideRequests';

function renderWithQuery(hook: () => ReturnType<typeof useOverrideRequests>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

describe('useOverrideRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({
      accessToken: 'mock-token',
      userId: 'admin-1',
      userRole: 'admin'
    } as never);
  });

  it('[A3-fix] enabled=false → query KHÔNG fetch (drawer đóng, tránh waste network)', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: { items: [], total: 0 }
    } as never);

    const { result } = renderWithQuery(() => useOverrideRequests(false));

    // Chờ 1 tick để đảm bảo không có fetch nào được kích hoạt
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('enabled=true (mặc định) → query fetch ngay khi mount', async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: { items: [{ overrideRequestId: 'req-1' }], total: 1 }
    } as never);

    const { result } = renderWithQuery(() => useOverrideRequests());

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('không có accessToken → query lỗi "Chưa đăng nhập", không gọi fetchApi', async () => {
    vi.mocked(readAuthSession).mockReturnValue(null as never);

    const { result } = renderWithQuery(() => useOverrideRequests(true));

    // Lỗi "Chưa đăng nhập" không có statusCode 401 → hook tự retry 1 lần (failureCount < 1)
    // trước khi isError=true, cần timeout dài hơn default để chờ qua retry delay (~1s).
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    }, { timeout: 3000 });
    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.error?.message).toBe('Chưa đăng nhập');
  });

  it('lỗi 401 từ fetchApi → KHÔNG retry (chỉ gọi API 1 lần)', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 401, message: 'Unauthorized', errorCode: 'UNAUTHORIZED' });

    const { result } = renderWithQuery(() => useOverrideRequests(true));

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    // Không retry khi 401 — chỉ 1 lần gọi
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});
