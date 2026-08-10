import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path)
}));

import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { buildGalleryUrl, useImpactSbtGallery } from '@/app/hooks/useImpactSbtGallery';
import type { ImpactSbtGalleryResponse } from '@/app/types/impactSbt';

const responseData: ImpactSbtGalleryResponse = {
  entries: [
    {
      onChainTokenId: 12,
      projectId: 'p-001',
      projectName: 'Dự án mẫu',
      milestone: 2,
      beneficiaryCount: 150,
      imageCid: 'QmImage',
      imageGatewayUrl: 'https://ipfs.io/ipfs/QmImage',
      onChainTokenStatus: 'ACTIVE',
      confirmedAt: '2026-08-01T10:00:00.000Z'
    }
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }
};

function renderGalleryHook(projectId?: string, page = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useImpactSbtGallery(projectId, page), { wrapper });
}

describe('useImpactSbtGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns res.data and keeps confirmedAt as an ISO string', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: responseData } as never);

    const { result } = renderGalleryHook();
    await waitFor(() => expect(result.current.data).toEqual(responseData));

    expect(result.current.data?.entries[0].confirmedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(buildApiUrl).toHaveBeenCalledWith('/api/sbt/gallery?page=1&limit=20');
  });

  it('encodes projectId and always uses the global gallery endpoint with limit <= 20', () => {
    expect(buildGalleryUrl(1, 'project 1/2')).toBe(
      '/api/sbt/gallery?page=1&limit=20&projectId=project%201%2F2'
    );
    expect(buildGalleryUrl(1)).not.toContain('projectId=');
  });

  it('clamps or falls back malformed pages before building the API URL', () => {
    expect(buildGalleryUrl(500)).toContain('page=500');
    expect(buildGalleryUrl(501)).toContain('page=500');
    expect(buildGalleryUrl(Number.NaN)).toContain('page=1');
    expect(buildGalleryUrl(Number.POSITIVE_INFINITY)).toContain('page=1');
  });

  it('uses the normalized max page in the query request rather than sending a 400 deep-link to the API', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: responseData } as never);

    const { result } = renderGalleryHook(undefined, 501);
    await waitFor(() => expect(result.current.data).toEqual(responseData));

    expect(buildApiUrl).toHaveBeenCalledWith('/api/sbt/gallery?page=500&limit=20');
  });

  it('does not retry 4xx including rate limit errors', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests'
    });

    const { result } = renderGalleryHook();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toBe('Too many requests');
  });

  it('retries one time for a transient 5xx error', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 503,
      errorCode: 'UNAVAILABLE',
      message: 'Unavailable'
    });

    const { result } = renderGalleryHook();
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 });

    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it('keeps previous page data while the next page is loading', async () => {
    let resolveNextPage: ((value: unknown) => void) | undefined;
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({ success: true, message: '', data: responseData } as never)
      .mockImplementationOnce(() => new Promise(resolve => { resolveNextPage = resolve; }) as never);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useImpactSbtGallery(undefined, page),
      { wrapper, initialProps: { page: 1 } }
    );

    await waitFor(() => expect(result.current.data).toEqual(responseData));
    rerender({ page: 2 });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));

    expect(result.current.data).toEqual(responseData);
    resolveNextPage?.({ success: true, message: '', data: responseData });
  });
});
