/**
 * Tests cho GeofenceMap + useGeofence (B3).
 * react-leaflet bị mock hoàn toàn vì Leaflet cần DOM thật (canvas, SVG).
 * Tập trung vào: snapshot-driven rendering, loading/error/no-geofence states,
 * marker verdict, popup metadata, NO_GPS overlay, fit bounds, legend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(() => ({ accessToken: 'mock-token' })),
}));

// Spies dùng chung cho useMap/latLngBounds — khai báo qua vi.hoisted vì vi.mock được hoist
// lên đầu file, không thể tham chiếu biến khai báo thường bên ngoài factory.
const mapSpies = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  setView: vi.fn(),
}));

// react-leaflet là DOM-only — mock toàn bộ để test trong jsdom.
// CircleMarker expose fillColor qua data-fill để assert màu verdict (VALID xanh, INVALID đỏ).
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map-container">{children}</div>
  ),
  TileLayer: ({ url }: { url: string }) => <div data-testid="tile-layer" data-url={url} />,
  Polygon: () => <div data-testid="polygon" />,
  Circle: ({ radius }: { radius: number }) => <div data-testid="circle" data-radius={radius} />,
  CircleMarker: ({
    children,
    center,
    pathOptions
  }: {
    children?: React.ReactNode;
    center?: [number, number];
    pathOptions?: { fillColor?: string };
  }) => (
    <div
      data-testid="circle-marker"
      data-center={Array.isArray(center) ? `${center[0]},${center[1]}` : ''}
      data-fill={pathOptions?.fillColor ?? ''}
    >
      {children}
    </div>
  ),
  Popup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
  useMap: () => ({ fitBounds: mapSpies.fitBounds, setView: mapSpies.setView }),
}));

// leaflet — mock để tránh lỗi khi không có canvas.
// latLngBounds giữ nguyên arg (mảng latLng) để assert marker ở xa được đưa vào bounds.
vi.mock('leaflet', () => ({
  default: {
    latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
    latLngBounds: vi.fn((points: unknown) => ({ isValid: () => true, points })),
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  },
  latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
  latLngBounds: vi.fn((points: unknown) => ({ isValid: () => true, points })),
}));

import { fetchApi } from '@/app/utils/apiClient';
import GeofenceMap from '@/app/components/oracle/GeofenceMap';
import type { GeofenceMapProps, GeofenceSnapshotView, GeofenceMarker } from '@/app/components/oracle/GeofenceMap';

// =============================================================================
// HELPERS
// =============================================================================

function renderWithQuery(ui: React.ReactElement) {
  // retry: 0 (số) để override cả custom retry function trong hook
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const MOCK_GEOFENCE = {
  projectId: 'project-123',
  polygon: [
    { lat: 10.76, lng: 106.68 },
    { lat: 10.77, lng: 106.69 },
    { lat: 10.76, lng: 106.70 },
  ],
  centroid: { lat: 10.763, lng: 106.69 },
  radiusMeters: 500,
};

const MOCK_SNAPSHOT: GeofenceSnapshotView = {
  polygon: [
    { lat: 10.76, lng: 106.68 },
    { lat: 10.77, lng: 106.69 },
    { lat: 10.76, lng: 106.70 },
  ],
  centroid: { lat: 10.763, lng: 106.69 },
  radiusMeters: 1000,
};

const defaultProps: GeofenceMapProps = {
  projectId: 'project-123',
};

// =============================================================================
// TESTS — fetch-driven mode (không truyền snapshot)
// =============================================================================

describe('GeofenceMap — fetch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hiển thị skeleton khi đang loading', () => {
    vi.mocked(fetchApi).mockReturnValue(new Promise(() => {})); // never resolves
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('hiển thị banner vàng khi dự án chưa có geofence (404)', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 404, message: 'Không tìm thấy', errorCode: 'NOT_FOUND' });
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/chưa thiết lập vùng địa lý/i)).toBeInTheDocument();
    });
  });

  it('hiển thị banner đỏ khi API lỗi không phải 404', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 500, message: 'Server error', errorCode: 'SERVER_ERROR' });
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-error-banner')).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('render map container khi có geofence data', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
  });

  it('render polygon và circle khi có geofence', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('polygon')).toBeInTheDocument();
      expect(screen.getByTestId('circle')).toBeInTheDocument();
    });
  });

  it('không render gì khi projectId rỗng', () => {
    renderWithQuery(<GeofenceMap projectId="" />);
    expect(screen.queryByTestId('map-container')).not.toBeInTheDocument();
  });

  it('tile URL đi qua proxy /api/tiles, không dùng OSM trực tiếp', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    await waitFor(() => {
      const tile = screen.getByTestId('tile-layer');
      expect(tile.getAttribute('data-url')).toContain('/api/tiles/');
      expect(tile.getAttribute('data-url')).not.toContain('tile.openstreetmap.org');
    });
  });
});

// =============================================================================
// TESTS — snapshot-driven mode (B3)
// =============================================================================

describe('GeofenceMap — snapshot mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dùng snapshot mà KHÔNG gọi API geofence', async () => {
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
    // Snapshot mode → không fetch geofence hiện tại
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('circle dùng radius từ snapshot (1000m), không phải giá trị fetch', async () => {
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} />);
    await waitFor(() => {
      const circle = screen.getByTestId('circle');
      expect(circle.getAttribute('data-radius')).toBe('1000');
    });
  });

  it('hiển thị banner cảnh báo khi snapshot = null (record cũ)', () => {
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={null} />);
    expect(screen.getByTestId('missing-snapshot-banner')).toBeInTheDocument();
    // Không fetch geofence hiện tại để tránh sai lệch verdict lịch sử
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TESTS — marker verdict, popup metadata, NO_GPS overlay
// =============================================================================

describe('GeofenceMap — markers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('render marker có tọa độ (VALID/INVALID) như circle-marker', async () => {
    const markers: GeofenceMarker[] = [
      { id: 'v-1', coordinate: { lat: 10.762, lng: 106.691 }, status: 'INVALID', evidenceCid: 'QmTest', distanceMeters: 750.5 },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      // 1 centroid + 1 marker GPS
      const circleMarkers = screen.getAllByTestId('circle-marker');
      expect(circleMarkers.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('NO_GPS KHÔNG vẽ pin địa lý — hiển thị overlay vàng "?"', async () => {
    const markers: GeofenceMarker[] = [
      { id: 'ng-1', coordinate: null, status: 'NO_GPS', evidenceCid: 'QmNoGps' },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByTestId('no-gps-overlay')).toBeInTheDocument();
    });
    // Chỉ còn centroid marker (1), không có marker cho NO_GPS
    const circleMarkers = screen.getAllByTestId('circle-marker');
    expect(circleMarkers).toHaveLength(1);
  });

  it('popup hiển thị tọa độ, khoảng cách và verdict message', async () => {
    const markers: GeofenceMarker[] = [
      {
        id: 'v-2',
        coordinate: { lat: 10.762345, lng: 106.691234 },
        status: 'INVALID',
        distanceMeters: 812.3,
        verificationMessage: 'Ảnh chụp ngoài vùng dự án',
        capturedAt: '2026-06-12T10:00:00.000Z',
      },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByText('10.762345, 106.691234')).toBeInTheDocument();
    });
    expect(screen.getByText(/812.3 m/)).toBeInTheDocument();
    expect(screen.getByText('Ảnh chụp ngoài vùng dự án')).toBeInTheDocument();
  });

  it('legend chỉ hiện status có mặt trong markers', async () => {
    const markers: GeofenceMarker[] = [
      { id: 'v-3', coordinate: { lat: 10.762, lng: 106.691 }, status: 'VALID' },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      // "Trong vùng" xuất hiện ở cả popup verdict và legend → dùng getAllByText
      expect(screen.getAllByText('Trong vùng').length).toBeGreaterThanOrEqual(1);
    });
    // Không có INVALID/NO_GPS marker → label không xuất hiện
    expect(screen.queryByText('Ngoài vùng')).not.toBeInTheDocument();
    expect(screen.queryByText('Không có GPS')).not.toBeInTheDocument();
  });

  it('không hiển thị legend khi không có marker', async () => {
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={[]} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
    expect(screen.queryByText(/chú thích/i)).not.toBeInTheDocument();
  });

  it('không tự render thumbnail trực tiếp từ evidenceCid', async () => {
    const markers: GeofenceMarker[] = [
      {
        id: 'v-4',
        coordinate: { lat: 10.762, lng: 106.691 },
        status: 'VALID',
        evidenceCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
    // Browser reviewer không tự gọi IPFS gateway chỉ vì có CID.
    expect(screen.queryByAltText('Ảnh minh chứng')).not.toBeInTheDocument();
  });

  it('thumbnail chỉ render từ URL safe/proxy được truyền vào marker', async () => {
    const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const safeThumbnailUrl = `/api/oracle/evidence-thumbnails/${validCid}`;
    const markers: GeofenceMarker[] = [
      {
        id: 'v-cid',
        coordinate: { lat: 10.762, lng: 106.691 },
        status: 'VALID',
        evidenceCid: validCid,
        evidenceThumbnailUrl: safeThumbnailUrl
      },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    const thumbnail = await screen.findByAltText('Ảnh minh chứng');
    expect(thumbnail).toBeInTheDocument();
    expect(thumbnail.getAttribute('src')).toBe(safeThumbnailUrl);
    expect(thumbnail.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('marker VALID dùng màu xanh, INVALID dùng màu đỏ (verdict Oracle)', async () => {
    const markers: GeofenceMarker[] = [
      { id: 'ok', coordinate: { lat: 10.7625, lng: 106.6915 }, status: 'VALID' },
      { id: 'bad', coordinate: { lat: 10.7635, lng: 106.6925 }, status: 'INVALID' },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
    const markerByCenter = new Map(
      screen.getAllByTestId('circle-marker').map((el) => [
        el.getAttribute('data-center'),
        el.getAttribute('data-fill')
      ])
    );
    expect(markerByCenter.get('10.7625,106.6915')).toBe('#22c55e');
    expect(markerByCenter.get('10.7635,106.6925')).toBe('#ef4444');
  });

  it('popup hiển thị timestamp đã định dạng khi có capturedAt', async () => {
    const markers: GeofenceMarker[] = [
      {
        id: 'ts-1',
        coordinate: { lat: 10.762, lng: 106.691 },
        status: 'VALID',
        capturedAt: '2026-06-12T10:00:00.000Z',
      },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByText(/Thời điểm:/)).toBeInTheDocument();
    });
    // Năm 2026 luôn xuất hiện trong chuỗi vi-VN bất kể timezone của máy chạy test
    expect(screen.getByText(/Thời điểm:.*2026/)).toBeInTheDocument();
  });

  it('fit bounds bao gồm marker INVALID ở xa để reviewer thấy toàn cảnh', async () => {
    // Marker INVALID cách polygon rất xa — phải nằm trong tập điểm fitBounds
    const farMarker = { lat: 11.5, lng: 107.5 };
    const markers: GeofenceMarker[] = [
      { id: 'far', coordinate: farMarker, status: 'INVALID', distanceMeters: 95000 },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />);
    await waitFor(() => {
      expect(mapSpies.fitBounds).toHaveBeenCalled();
    });
    // fitBounds nhận L.latLngBounds(points) — mock giữ points; kiểm tra marker xa có mặt
    const boundsArg = mapSpies.fitBounds.mock.calls[0]?.[0] as { points: Array<{ lat: number; lng: number }> };
    const hasFarMarker = boundsArg.points.some(
      (p) => p.lat === farMarker.lat && p.lng === farMarker.lng
    );
    expect(hasFarMarker).toBe(true);
  });

  it('không fitBounds lại khi rerender với cùng tọa độ polygon và marker', async () => {
    const markers: GeofenceMarker[] = [
      { id: 'stable', coordinate: { lat: 10.762, lng: 106.691 }, status: 'INVALID' },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <GeofenceMap {...defaultProps} snapshot={MOCK_SNAPSHOT} markers={markers} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(mapSpies.fitBounds).toHaveBeenCalledTimes(1);
    });

    rerender(
      <QueryClientProvider client={client}>
        <GeofenceMap
          {...defaultProps}
          snapshot={{
            polygon: MOCK_SNAPSHOT.polygon.map((point) => ({ ...point })),
            centroid: { ...MOCK_SNAPSHOT.centroid },
            radiusMeters: MOCK_SNAPSHOT.radiusMeters
          }}
          markers={markers.map((marker) => ({
            ...marker,
            coordinate: marker.coordinate ? { ...marker.coordinate } : null
          }))}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(mapSpies.fitBounds).toHaveBeenCalledTimes(1);
    });
  });
});
