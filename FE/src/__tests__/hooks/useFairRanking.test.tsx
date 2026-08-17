import type { PropsWithChildren, ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrustAdjustedRankingUrl,
  normalizeFairRankingWalletAddress,
  shouldRetryFairRanking,
  useFairRanking
} from '@/app/hooks/useFairRanking';
import { fetchApi } from '@/app/utils/apiClient';
import { clearAuthSession, persistAuthSession } from '@/app/utils/authSession';

const mocks = vi.hoisted(() => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: mocks.buildApiUrl,
  fetchApi: mocks.fetchApi
}));

/** Bọc hook bằng QueryClient mới để mỗi test không dùng lại cache của test trước. */
function createWrapper(): ({ children }: PropsWithChildren) => ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function QueryWrapper({ children }: PropsWithChildren): ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useFairRanking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.fetchApi.mockResolvedValue({ success: true, message: '', data: { rankings: [] } });
  });

  it('build path dung endpoint va lowercase donor address, khong them /api', () => {
    expect(normalizeFairRankingWalletAddress('0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(buildTrustAdjustedRankingUrl('project/a', 'trustAdjusted', 2, '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')).toBe(
      '/rankings/trust-adjusted?projectId=project%2Fa&sortBy=trustAdjusted&page=2&limit=20&donorAddress=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    );
  });

  it('khong fetch tab inactive va fetch active voi limit=20 sau khi hydrate wallet', async () => {
    window.localStorage.setItem('dcpUserWalletAddress', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD');
    window.localStorage.setItem('dcpAccessToken', 'access-token');
    const inactive = renderHook(
      () => useFairRanking({ projectId: 'project-1', sortBy: 'trustAdjusted', page: 1, enabled: false }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(inactive.result.current.isFetched).toBe(false));
    expect(fetchApi).not.toHaveBeenCalled();

    const active = renderHook(
      () => useFairRanking({ projectId: 'project-1', sortBy: 'trustAdjusted', page: 1, enabled: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    expect(fetchApi).toHaveBeenCalledWith(
      '/rankings/trust-adjusted?projectId=project-1&sortBy=trustAdjusted&page=1&limit=20&donorAddress=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: { Authorization: 'Bearer access-token' }
      })
    );
    active.unmount();
  });

  it('khong gui donorAddress neu chi co wallet trong localStorage ma khong co access token', async () => {
    window.localStorage.setItem('dcpUserWalletAddress', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD');

    const active = renderHook(
      () => useFairRanking({ projectId: 'project-1', sortBy: 'trustAdjusted', page: 1, enabled: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    expect(fetchApi).toHaveBeenCalledWith(
      '/rankings/trust-adjusted?projectId=project-1&sortBy=trustAdjusted&page=1&limit=20',
      expect.objectContaining({ headers: undefined })
    );
    active.unmount();
  });

  it('cap nhat request khi login va logout trong cung page', async () => {
    const active = renderHook(
      () => useFairRanking({ projectId: 'project-1', sortBy: 'trustAdjusted', page: 1, enabled: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    act(() => {
      persistAuthSession({
        accessToken: 'session-token',
        userWalletAddress: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD'
      });
    });
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2));
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/rankings/trust-adjusted?projectId=project-1&sortBy=trustAdjusted&page=1&limit=20&donorAddress=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expect.objectContaining({ headers: { Authorization: 'Bearer session-token' } })
    );

    act(() => {
      clearAuthSession();
    });
    await waitFor(() => expect(active.result.current.data).toEqual({ rankings: [] }));
    expect(fetchApi).toHaveBeenCalledTimes(2);
    active.unmount();
  });

  it('ha token 401 thi bo session va fetch lai ranking public', async () => {
    window.localStorage.setItem('dcpUserWalletAddress', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD');
    window.localStorage.setItem('dcpAccessToken', 'expired-token');
    mocks.fetchApi
      .mockRejectedValueOnce({ statusCode: 401, message: 'expired', errorCode: 'UNAUTHORIZED' })
      .mockResolvedValueOnce({ success: true, message: '', data: { rankings: [] } });

    const active = renderHook(
      () => useFairRanking({ projectId: 'project-1', sortBy: 'trustAdjusted', page: 1, enabled: true }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2));
    expect(mocks.fetchApi.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: { Authorization: 'Bearer expired-token' } }));
    expect(mocks.fetchApi.mock.calls[1][0]).toBe('/rankings/trust-adjusted?projectId=project-1&sortBy=trustAdjusted&page=1&limit=20');
    expect(mocks.fetchApi.mock.calls[1][1]).toEqual(expect.objectContaining({ headers: undefined }));
    active.unmount();
  });

  it('retry policy khong retry 4xx va chi retry mot lan cho loi 5xx', () => {
    expect(shouldRetryFairRanking(0, { statusCode: 400 } as never)).toBe(false);
    expect(shouldRetryFairRanking(0, { statusCode: 429 } as never)).toBe(false);
    expect(shouldRetryFairRanking(0, { statusCode: 500 } as never)).toBe(true);
    expect(shouldRetryFairRanking(1, { statusCode: 500 } as never)).toBe(false);
  });
});
