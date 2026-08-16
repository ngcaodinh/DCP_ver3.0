import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SbtTokenDetailResponse } from '@/app/types/impactSbt';

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  })
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/app/components/impactSbt/SbtImage', () => ({
  default: ({ alt }: { alt: string }) => <div data-testid="page-sbt-image">{alt}</div>
}));
vi.mock('@/app/components/impactSbt/SbtMetadataPanel', () => ({
  default: ({ offChain }: { offChain: { transactionHash: string | null } | null }) => (
    <div data-testid="page-sbt-metadata">{offChain?.transactionHash ?? 'no-off-chain'}</div>
  )
}));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: ({ projectId, snapshot }: { projectId: string; snapshot: unknown }) => (
    <div
      data-testid="page-sbt-geofence"
      data-project-id={projectId}
      data-snapshot={JSON.stringify(snapshot)}
    />
  )
}));
vi.mock('@/app/components/impactSbt/SbtMilestoneTimeline', () => ({
  default: ({ entries }: { entries: Array<{ milestone: number }> }) => (
    <div data-testid="page-sbt-timeline">{entries.map(entry => entry.milestone).join(',')}</div>
  )
}));
vi.mock('@/app/components/impactSbt/SbtPolygonScanLink', () => ({
  default: ({ transactionHash }: { transactionHash: string | null }) => (
    <div data-testid="page-sbt-polygon">{transactionHash ?? 'no-transaction'}</div>
  )
}));

import SbtTokenPage from '@/app/impact-gallery/[tokenId]/page';

/** Tạo Response JSON tối giản cho các nhánh SSR của trang SBT detail. */
function createResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Tạo detail đầy đủ để test orchestration mà không phụ thuộc backend thật. */
function makeDetail(overrides: Partial<SbtTokenDetailResponse> = {}): SbtTokenDetailResponse {
  return {
    onChainTokenId: 12,
    onChain: {
      projectId: 5,
      milestone: 2,
      beneficiaryCount: 150,
      gpsCoordinates: '10.8231,106.6297',
      imageCID: 'QmImage',
      mintedAt: '2026-08-01T10:00:00.000Z',
      tokenStatus: 'ACTIVE'
    },
    offChain: {
      projectId: 'project-1',
      milestone: 2,
      beneficiaryCount: 150,
      imageCid: 'QmImage',
      tokenUri: 'ipfs://QmMetadata',
      confirmedAt: '2026-08-01T10:00:00.000Z',
      transactionHash: '0xtx',
      tokenStatusReason: null
    },
    imageGatewayUrl: 'https://ipfs.io/ipfs/QmImage',
    ipfsMetadata: { name: 'Impact SBT' },
    ipfsError: null,
    cached: false,
    ...overrides
  };
}

/** Tạo response project theo contract gallery dùng cho milestone timeline. */
function makeProjectResponse(entries: Array<{ milestone: number; onChainTokenId: number }>, totalPages = 1): unknown {
  return {
    success: true,
    data: {
      entries: entries.map(entry => ({
        onChainTokenId: entry.onChainTokenId,
        projectId: 'project-1',
        projectName: 'Dự án mẫu',
        milestone: entry.milestone,
        beneficiaryCount: 10,
        imageCid: 'QmImage',
        imageGatewayUrl: null,
        onChainTokenStatus: 'ACTIVE',
        confirmedAt: '2026-08-01T10:00:00.000Z'
      })),
      pagination: { page: 1, limit: 20, total: entries.length, totalPages }
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SbtTokenPage', () => {
  it('fetches full detail, merges milestone pages and renders all sections', async () => {
    const requestedUrls: string[] = [];
    const ssrRequestHeaders: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      ssrRequestHeaders.push(new Headers(init?.headers).get('X-DCP-SSR-Request'));
      if (url.includes('/api/sbt/token/12')) return Promise.resolve(createResponse({ success: true, data: makeDetail() }));
      if (url.includes('page=1')) return Promise.resolve(createResponse(makeProjectResponse([{ milestone: 3, onChainTokenId: 30 }, { milestone: 1, onChainTokenId: 10 }], 2)));
      return Promise.resolve(createResponse(makeProjectResponse([{ milestone: 2, onChainTokenId: 20 }], 2)));
    }));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    expect(screen.getByTestId('page-sbt-image')).toHaveTextContent('Impact SBT #12');
    expect(screen.getByTestId('page-sbt-metadata')).toHaveTextContent('0xtx');
    expect(screen.getByTestId('sbt-location-map')).toBeInTheDocument();
    expect(screen.getByTestId('page-sbt-geofence')).toBeInTheDocument();
    expect(screen.getByTestId('page-sbt-timeline')).toHaveTextContent('1,2,3');
    expect(screen.getByTestId('page-sbt-polygon')).toHaveTextContent('0xtx');
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls.some(url => url.includes('page=2'))).toBe(true);
    expect(ssrRequestHeaders).toEqual(['1', '1', '1']);
  });

  it('caps milestone requests at five pages when the project has more pages', async () => {
    const requestedUrls: string[] = [];
    const entriesByPage = new Map([
      [1, [{ milestone: 3, onChainTokenId: 30 }, { milestone: 1, onChainTokenId: 10 }]],
      [2, [{ milestone: 4, onChainTokenId: 40 }]],
      [3, [{ milestone: 2, onChainTokenId: 20 }]],
      [4, [{ milestone: 5, onChainTokenId: 50 }]],
      [5, [{ milestone: 6, onChainTokenId: 60 }]]
    ]);

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/sbt/token/12')) {
        return Promise.resolve(createResponse({ success: true, data: makeDetail() }));
      }

      const page = Number(new URL(url).searchParams.get('page'));
      const entries = entriesByPage.get(page);
      if (!entries) return Promise.reject(new Error(`Unexpected milestone page: ${page}`));
      return Promise.resolve(createResponse(makeProjectResponse(entries, 10)));
    }));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    const milestoneUrls = requestedUrls.filter(url => url.includes('/api/sbt/project/project-1?'));
    expect(milestoneUrls).toHaveLength(5);
    expect(milestoneUrls.map(url => new URL(url).searchParams.get('page')).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5'
    ]);
    expect(screen.getByTestId('page-sbt-timeline')).toHaveTextContent('1,2,3,4,5,6');
  });

  it.each([400, 404])('routes HTTP %s token response to local not-found', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ success: false }, status)));

    await expect(SbtTokenPage({ params: { tokenId: status === 400 ? 'abc' : '999999' } })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it.each([500, 503])('renders retry UI for infrastructure HTTP %s errors', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ success: false }, status)));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    expect(screen.getByRole('heading', { name: 'Không tải được SBT' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Thử lại' })).toHaveAttribute('href', '/impact-gallery/12');
  });

  it('renders retry UI when the detail request exceeds the server timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    const pagePromise = SbtTokenPage({ params: { tokenId: '12' } });
    await vi.advanceTimersByTimeAsync(10_000);
    const element = await pagePromise;
    render(element);

    expect(screen.getByRole('heading', { name: 'Không tải được SBT' })).toBeInTheDocument();
  });

  it('degrades the timeline after the shorter milestone timeout', async () => {
    vi.useFakeTimers();
    let milestoneAbortCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/sbt/token/12')) {
        return Promise.resolve(createResponse({ success: true, data: makeDetail() }));
      }

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          milestoneAbortCount += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }));

    const pagePromise = SbtTokenPage({ params: { tokenId: '12' } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(milestoneAbortCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const element = await pagePromise;
    render(element);

    expect(milestoneAbortCount).toBe(1);
    expect(screen.getByText('Không tải được danh sách milestone.')).toBeInTheDocument();
  });

  it('degrades only the timeline when the milestone API fails', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/sbt/token/12')) return Promise.resolve(createResponse({ success: true, data: makeDetail() }));
      return Promise.resolve(createResponse({ success: false }, 503));
    }));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    expect(screen.getByTestId('sbt-location-map')).toBeInTheDocument();
    expect(screen.getByText('Không tải được danh sách milestone.')).toBeInTheDocument();
    expect(screen.queryByTestId('page-sbt-timeline')).not.toBeInTheDocument();
    expect(requestedUrls).toHaveLength(2);
  });

  it('keeps the page usable when offChain is null and still renders location section', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Promise.resolve(createResponse({
        success: true,
        data: makeDetail({ offChain: null, onChain: { ...makeDetail().onChain, milestone: 4 } })
      }));
    }));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    expect(screen.getByTestId('sbt-location-map')).toBeInTheDocument();
    expect(screen.getByText(/Milestone: 4/)).toBeInTheDocument();
    expect(screen.queryByTestId('page-sbt-timeline')).not.toBeInTheDocument();
    expect(screen.getByTestId('page-sbt-polygon')).toHaveTextContent('no-transaction');
    expect(JSON.parse(screen.getByTestId('page-sbt-geofence').getAttribute('data-snapshot') ?? '')).toEqual({
      polygon: [],
      centroid: { lat: 10.8231, lng: 106.6297 },
      radiusMeters: 0
    });
    expect(requestedUrls).toHaveLength(1);
  });

  it('renders retry UI when a successful response has an invalid shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ success: true, data: { onChain: {} } })));

    const element = await SbtTokenPage({ params: { tokenId: '12' } });
    render(element);

    expect(screen.getByRole('heading', { name: 'Không tải được SBT' })).toBeInTheDocument();
  });
});
