/**
 * Tests cho GpsMarkerOnlyMapInner (B4).
 * react-leaflet bị mock hoàn toàn vì Leaflet cần DOM thật (canvas, SVG).
 * Tập trung vào: render marker dự án luôn có, marker ảnh chỉ khi có gpsFromImage,
 * legend hiển thị đúng số lượng mục, BoundsAutoFitter không crash khi 1 hoặc 2 điểm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// =============================================================================
// MOCKS
// =============================================================================

const fitBoundsMock = vi.fn();
const setViewMock = vi.fn();

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map-container">{children}</div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
  CircleMarker: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="circle-marker">{children}</div>
  ),
  Popup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
  useMap: () => ({ fitBounds: fitBoundsMock, setView: setViewMock }),
}));

vi.mock('leaflet', () => ({
  default: {
    latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
    latLngBounds: vi.fn(() => ({ isValid: () => true })),
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  },
}));

import GpsMarkerOnlyMapInner from '@/app/components/oracle/GpsMarkerOnlyMapInner';

// =============================================================================
// FIXTURES
// =============================================================================

const PROJECT_GPS = { lat: 10.762, lng: 106.660 };
const IMAGE_GPS = { lat: 10.770, lng: 106.680 };

// =============================================================================
// TESTS
// =============================================================================

describe('GpsMarkerOnlyMapInner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('render map container và marker GPS dự án khi không có gpsFromImage', () => {
    render(<GpsMarkerOnlyMapInner gpsFromImage={null} gpsFromProject={PROJECT_GPS} />);

    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    // Chỉ 1 CircleMarker (GPS dự án) khi không có gpsFromImage
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(1);
    // "Trung tâm dự án" xuất hiện cả ở Popup và Legend → dùng getAllByText
    expect(screen.getAllByText('Trung tâm dự án').length).toBeGreaterThanOrEqual(1);
    // Legend không hiển thị mục "GPS từ ảnh" khi gpsFromImage = null
    expect(screen.queryByText('GPS từ ảnh')).not.toBeInTheDocument();
  });

  it('render đủ 2 marker (dự án + ảnh) khi có gpsFromImage', () => {
    render(<GpsMarkerOnlyMapInner gpsFromImage={IMAGE_GPS} gpsFromProject={PROJECT_GPS} />);

    expect(screen.getAllByTestId('circle-marker')).toHaveLength(2);
    expect(screen.getAllByText('Trung tâm dự án').length).toBeGreaterThanOrEqual(1);
    // "GPS từ ảnh" xuất hiện cả ở Popup và Legend
    expect(screen.getAllByText('GPS từ ảnh').length).toBeGreaterThanOrEqual(1);
  });

  it('hiển thị tọa độ định dạng 6 chữ số thập phân trong Popup', () => {
    render(<GpsMarkerOnlyMapInner gpsFromImage={IMAGE_GPS} gpsFromProject={PROJECT_GPS} />);

    expect(screen.getByText(`${PROJECT_GPS.lat.toFixed(6)}, ${PROJECT_GPS.lng.toFixed(6)}`)).toBeInTheDocument();
    expect(screen.getByText(`${IMAGE_GPS.lat.toFixed(6)}, ${IMAGE_GPS.lng.toFixed(6)}`)).toBeInTheDocument();
  });

  it('áp dụng className truyền vào container', () => {
    render(
      <GpsMarkerOnlyMapInner
        gpsFromImage={null}
        gpsFromProject={PROJECT_GPS}
        className="custom-test-class"
      />
    );

    const container = screen.getByTestId('map-container').parentElement;
    expect(container).toHaveClass('custom-test-class');
  });
});
