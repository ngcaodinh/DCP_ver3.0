import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  buildSameOriginApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi,
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'governance-token' }) }));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({ GeofenceMapLazy: () => <div data-testid="gps-map">GPS map</div> }));

import { ActiveProjectsPanel } from '@/app/components/governance/ActiveProjectsPanel';

const activeProject = {
  projectId: 'project-critical',
  name: 'Dự án vùng xa',
  organizationName: 'Tổ chức minh bạch',
  fieldReportCount: 2,
  pendingDisbursementCount: 1
};

const activeProjectDetail = {
  highestDeviationLevel: 'CRITICAL' as const,
  geofence: { centroid: { lat: 10.018, lng: 105.758 }, polygon: [], radiusMeters: 100 },
  listingVerifications: [{
    verificationId: 'verification-1',
    auditorLabel: 'Kiểm toán viên A',
    note: 'Đã xác minh thực địa trước khi kích hoạt.',
    submittedAt: '2026-08-29T00:00:00.000Z',
    evidencePhotos: [{
      cid: 'bafy-listing-verification',
      source: 'AUDITOR_LISTING_VERIFICATION',
      gps: { lat: 10.0182, lng: 105.758 },
      accuracyMeters: 88,
      distanceMeters: 0,
      distanceToProjectCenterMeters: 22,
      isInsideGeofence: true,
      deviationLevel: 'INSIDE' as const,
      isLowAccuracyOverride: false,
      lowAccuracyReason: null,
      capturedAt: '2026-08-29T00:00:00.000Z'
    }]
  }],
  evidencePhotos: [{
    cid: 'bafy-critical',
    source: 'AUDITOR_FIELD_REPORT',
    deviationLevel: 'CRITICAL' as const,
    distanceMeters: 800,
    accuracyMeters: 10,
    isLowAccuracyOverride: true,
    lowAccuracyReason: 'Thiết bị mất tín hiệu trong nhà.'
  }]
};

/** Bọc panel bằng QueryClient riêng để mỗi test có cache server state độc lập. */
function renderPanel(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ActiveProjectsPanel /></QueryClientProvider>);
}

describe('ActiveProjectsPanel evidence deviation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchApi.mockImplementation((url: string) => (
      url.includes('/active-projects/project-critical')
        ? Promise.resolve({ data: activeProjectDetail })
        : Promise.resolve({ data: { items: [activeProject], nextCursor: null } })
    ));
  });

  it('đưa cảnh báo CRITICAL vào đầu detail và hiển thị cờ low-accuracy override', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án vùng xa/i }));

    const detailHeading = await screen.findByText('Chứng cứ hiện trường');
    const detailSection = detailHeading.closest('section');
    expect(detailSection).not.toBeNull();
    expect(within(detailSection as HTMLElement).getAllByText(/Lệch vị trí nghiêm trọng/)).not.toHaveLength(0);
    expect(within(detailSection as HTMLElement).getByText(/Chụp qua van thoát/)).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getByText(/Thiết bị mất tín hiệu trong nhà\./)).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getAllByText('Ảnh xác minh thực địa khi niêm yết')).not.toHaveLength(0);
    expect(within(detailSection as HTMLElement).getByText('Đã xác minh thực địa trước khi kích hoạt.')).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getByText('Khoảng cách đến tâm vị trí dự án')).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getByText(/Trong vùng dự án/)).not.toHaveTextContent('0 m');
    expect(within(detailSection as HTMLElement).getByRole('link', { name: 'Mở vị trí dự án trên Google Maps' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=10.018%2C105.758');
    expect(within(detailSection as HTMLElement).getAllByText('Báo cáo khảo sát thực địa')).not.toHaveLength(0);
    expect(within(detailSection as HTMLElement).getByText('Hồ sơ minh chứng giải ngân')).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getByText('Chưa có hồ sơ minh chứng cho các yêu cầu giải ngân.')).toBeInTheDocument();
  });

  it('gửi access token khi tải danh sách và detail dự án', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án vùng xa/i }));

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      '/api/project-governance/executive/active-projects?limit=20',
      { headers: { Authorization: 'Bearer governance-token' } }
    ));
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      '/api/project-governance/executive/active-projects/project-critical',
      { headers: { Authorization: 'Bearer governance-token' } }
    ));
  });
});
