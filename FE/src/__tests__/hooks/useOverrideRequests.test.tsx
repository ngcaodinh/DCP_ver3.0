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
import { useOverrideRequestDetail, useOverrideRequests } from '@/app/hooks/useOverrideRequests';

function renderWithQuery<T>(hook: () => T) {
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

  it('[B3] detail hook id=null → KHÔNG fetch detail snapshot', async () => {
    const { result } = renderWithQuery(() => useOverrideRequestDetail(null));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchApi).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('[B3] detail hook gọi đúng endpoint, Authorization header và trả geofenceSnapshot', async () => {
    const detailPayload = {
      overrideRequestId: 'req-001',
      projectId: 'proj-001',
      organizationId: 'org-001',
      evidenceCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      disbursementRequestId: null,
      reason: 'OUT_OF_GEOFENCE',
      gpsFromImage: { lat: 10.123456, lng: 106.654321 },
      gpsFromProject: { lat: 10.1, lng: 106.6 },
      distanceMeters: 750.5,
      commissionerSnapshot: [{ role: 'admin', isCurrentUser: true }],
      votes: [],
      status: 'PENDING',
      createdAt: '2026-06-12T10:00:00.000Z',
      geofenceSnapshot: {
        polygon: [
          { lat: 10.1, lng: 106.6 },
          { lat: 10.2, lng: 106.6 },
          { lat: 10.2, lng: 106.7 }
        ],
        centroid: { lat: 10.15, lng: 106.65 },
        radiusMeters: 1000
      },
      geofenceSnapshotUnavailable: false
    };
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: detailPayload
    } as never);

    const { result } = renderWithQuery(() => useOverrideRequestDetail('req-001'));

    await waitFor(() => {
      expect(result.current.data?.geofenceSnapshot?.radiusMeters).toBe(1000);
    });
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/oracle/override-requests/req-001',
      { headers: { Authorization: 'Bearer mock-token' } }
    );
  });
});
