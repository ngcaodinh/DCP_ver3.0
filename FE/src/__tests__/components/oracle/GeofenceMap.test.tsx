/**
 * Tests cho GeofenceMap + useGeofence (B3).
 * react-leaflet bị mock hoàn toàn vì Leaflet cần DOM thật (canvas, SVG).
 * Tập trung vào: loading state, no-geofence banner, error banner,
 * render map khi có data, marker color logic.
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

// react-leaflet là DOM-only — mock toàn bộ để test trong jsdom
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map-container">{children}</div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
  Polygon: () => <div data-testid="polygon" />,
  Circle: () => <div data-testid="circle" />,
  CircleMarker: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="circle-marker">{children}</div>
  ),
  Marker: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="marker">{children}</div>
  ),
  Popup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
  useMap: () => ({ fitBounds: vi.fn() }),
}));

// leaflet — mock để tránh lỗi khi không có canvas
vi.mock('leaflet', () => ({
  default: {
    latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
    latLngBounds: vi.fn(() => ({ isValid: () => true })),
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  },
  latLng: vi.fn(),
  latLngBounds: vi.fn(() => ({ isValid: () => true })),
}));

import { fetchApi } from '@/app/utils/apiClient';
import GeofenceMap from '@/app/components/oracle/GeofenceMap';
import type { GeofenceMapProps } from '@/app/components/oracle/GeofenceMap';

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

const defaultProps: GeofenceMapProps = {
  projectId: 'project-123',
};

// =============================================================================
// TESTS
// =============================================================================

describe('GeofenceMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hiển thị skeleton khi đang loading', () => {
    vi.mocked(fetchApi).mockReturnValue(new Promise(() => {})); // never resolves
    renderWithQuery(<GeofenceMap {...defaultProps} />);
    // Skeleton dùng animate-pulse
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

  it('render markers GPS khi có props markers', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    const markers = [
      { lat: 10.762, lng: 106.691, status: 'INVALID' as const, label: 'CID: abc123' },
    ];
    renderWithQuery(<GeofenceMap {...defaultProps} markers={markers} />);
    await waitFor(() => {
      // CircleMarker xuất hiện: 1 centroid + 1 marker GPS
      const circleMarkers = screen.getAllByTestId('circle-marker');
      expect(circleMarkers.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('không hiển thị legend khi không có markers', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceMap {...defaultProps} markers={[]} />);
    await waitFor(() => {
      expect(screen.queryByText(/chú thích/i)).not.toBeInTheDocument();
    });
  });

  it('hiển thị legend khi có markers', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    const markers = [{ lat: 10.762, lng: 106.691, status: 'VALID' as const }];
    renderWithQuery(<GeofenceMap {...defaultProps} markers={markers} />);
    await waitFor(() => {
      expect(screen.getByText(/chú thích/i)).toBeInTheDocument();
    });
  });

  it('không render gì khi projectId undefined', () => {
    // enabled: false khi projectId undefined → không fetch, không render map
    renderWithQuery(<GeofenceMap projectId="" />);
    expect(screen.queryByTestId('map-container')).not.toBeInTheDocument();
  });
});

// =============================================================================
// Marker color logic (unit test helper MARKER_COLORS)
// =============================================================================

describe('GeofenceMarkerStatus labels', () => {
  // Text xuất hiện ở cả Popup và Legend → dùng getAllByText, expect >= 1 match

  it('VALID hiển thị label đúng trong legend/popup', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    const markers = [{ lat: 10.762, lng: 106.691, status: 'VALID' as const }];
    renderWithQuery(<GeofenceMap {...defaultProps} markers={markers} />);
    await waitFor(() => {
      const matches = screen.getAllByText('Trong vùng');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('INVALID hiển thị label đúng trong legend/popup', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    const markers = [{ lat: 10.762, lng: 106.691, status: 'INVALID' as const }];
    renderWithQuery(<GeofenceMap {...defaultProps} markers={markers} />);
    await waitFor(() => {
      const matches = screen.getAllByText('Ngoài vùng');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('NO_GPS hiển thị label đúng trong legend/popup', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    const markers = [{ lat: 10.762, lng: 106.691, status: 'NO_GPS' as const }];
    renderWithQuery(<GeofenceMap {...defaultProps} markers={markers} />);
    await waitFor(() => {
      const matches = screen.getAllByText('Không có GPS');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });
});
