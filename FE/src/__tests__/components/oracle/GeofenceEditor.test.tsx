/**
 * Tests cho GeofenceEditor + useUpsertGeofence (B5).
 * react-leaflet bị mock hoàn toàn vì Leaflet cần DOM thật.
 * Tập trung vào: load existing geofence, vẽ polygon, validation,
 * radius input, save success/error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// =============================================================================
// MOCKS
// =============================================================================

// vi.hoisted() để khai báo biến mock trước khi vi.mock() factory được hoisting
const { mockUseMapEvents } = vi.hoisted(() => ({
  mockUseMapEvents: vi.fn(),
}));

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
  CircleMarker: ({
    children,
    eventHandlers,
  }: {
    children?: React.ReactNode;
    eventHandlers?: { click?: () => void };
  }) => (
    <div data-testid="circle-marker" onClick={eventHandlers?.click}>
      {children}
    </div>
  ),
  Polyline: () => <div data-testid="polyline" />,
  Popup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
  useMapEvents: mockUseMapEvents,
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
import GeofenceEditor from '@/app/components/oracle/GeofenceEditor';

// =============================================================================
// HELPERS
// =============================================================================

type ClickEventArg = { latlng: { lat: number; lng: number } };
type ClickHandler = (e: ClickEventArg) => void;

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * Setup mock useMapEvents để capture click handler, trả về setter.
 * Phải gọi trước mỗi test cần simulate click trên bản đồ.
 */
function setupMapClickCapture(): { getClickHandler: () => ClickHandler | null } {
  let handler: ClickHandler | null = null;
  mockUseMapEvents.mockImplementation((handlers: { click?: ClickHandler }) => {
    if (handlers.click) {
      handler = handlers.click;
    }
    return null;
  });
  return { getClickHandler: () => handler };
}

const MOCK_GEOFENCE = {
  projectId: 'project-abc',
  polygon: [
    { lat: 10.76, lng: 106.68 },
    { lat: 10.77, lng: 106.69 },
    { lat: 10.76, lng: 106.70 },
  ],
  centroid: { lat: 10.763, lng: 106.69 },
  radiusMeters: 800,
};

// =============================================================================
// TESTS
// =============================================================================

describe('GeofenceEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: useMapEvents không làm gì
    mockUseMapEvents.mockImplementation(() => null);
  });

  // -------------------------------------------------------------------
  // Loading & initial state
  // -------------------------------------------------------------------

  it('hiển thị skeleton khi đang loading geofence', () => {
    vi.mocked(fetchApi).mockReturnValue(new Promise(() => {})); // never resolves
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('load geofence hiện tại: pre-populate radius từ dữ liệu BE', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      const radiusInput = screen.getByTestId('radius-input') as HTMLInputElement;
      expect(radiusInput.value).toBe('800');
    });
  });

  it('hiển thị polygon khi đã có geofence', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('polygon')).toBeInTheDocument();
    });
  });

  it('khi dự án chưa có geofence (404), enable draw mode mặc định', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('drawing-banner')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------
  // Polygon drawing
  // -------------------------------------------------------------------

  it('thêm điểm khi click trên map ở draw mode', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });

    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    // Chờ draw mode kích hoạt (isDrawing=true) để handler có isDrawing=true
    await waitFor(() => screen.getByTestId('drawing-banner'));

    // Simulate 3 click events để tạo polygon hợp lệ
    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });
    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.70 } });

    await waitFor(() => {
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');
    });
  });

  it('toggle draw mode khi click nút "Tiếp tục vẽ"', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('btn-toggle-draw'));

    const btn = screen.getByTestId('btn-toggle-draw');
    expect(btn).toHaveTextContent('Tiếp tục vẽ');
    fireEvent.click(btn);
    expect(btn).toHaveTextContent('Dừng vẽ');
  });

  it('xóa điểm cuối khi click "Xóa điểm cuối"', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('2 điểm'));

    fireEvent.click(screen.getByTestId('btn-undo'));

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('1 điểm'));
  });

  it('reset polygon về rỗng khi click "Vẽ lại"', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });

    fireEvent.click(screen.getByTestId('btn-reset'));

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('0 điểm'));
  });

  // -------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------

  it('khi polygon < 3 điểm và click Save, thì show error "Polygon phải có ít nhất 3 điểm"', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    // Chỉ thêm 2 điểm — chưa đủ 3
    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('2 điểm'));

    // Nút Save không bị disabled — click được và show error
    expect(screen.getByTestId('btn-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent('Polygon phải có ít nhất 3 điểm');
    });
  });

  it('khi radiusMeters > 2000m và NGO set, thì show error "Bán kính tối đa 2000m"', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => {
      const input = screen.getByTestId('radius-input') as HTMLInputElement;
      expect(input.value).toBe('800');
    });

    // Nhập giá trị vượt max
    fireEvent.change(screen.getByTestId('radius-input'), { target: { value: '2500' } });

    await waitFor(() => {
      expect(screen.getByTestId('radius-error')).toHaveTextContent('Bán kính tối đa 2000m');
    });
  });

  // -------------------------------------------------------------------
  // Radius
  // -------------------------------------------------------------------

  it('cập nhật giá trị radius khi kéo slider', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    // Chờ geofence load xong và radius được pre-fill (800) trước khi tương tác
    await waitFor(() => {
      const input = screen.getByTestId('radius-input') as HTMLInputElement;
      expect(input.value).toBe('800');
    });

    const slider = screen.getByTestId('radius-slider') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '1200' } });

    expect(screen.getByTestId('radius-value')).toHaveTextContent('1200 m');
  });

  it('project.radiusMeters = 1000m → hiển thị đúng giá trị từ geofence hiện tại', async () => {
    const geofenceWith1000 = { ...MOCK_GEOFENCE, radiusMeters: 1000 };
    vi.mocked(fetchApi).mockResolvedValue({
      success: true,
      message: '',
      data: geofenceWith1000,
    });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('radius-value')).toHaveTextContent('1000 m');
    });
  });

  it('hiển thị cảnh báo diện tích lớn khi > 100 km²', async () => {
    vi.mocked(fetchApi).mockRejectedValue({
      statusCode: 404,
      message: 'Not found',
      errorCode: 'NOT_FOUND',
    });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    // Polygon rất lớn: ~1200km²
    getClickHandler()?.({ latlng: { lat: 10.0, lng: 106.0 } });
    getClickHandler()?.({ latlng: { lat: 20.0, lng: 106.0 } });
    getClickHandler()?.({ latlng: { lat: 20.0, lng: 116.0 } });

    await waitFor(() => {
      expect(screen.getByTestId('area-warning-banner')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------
  // Save success / error
  // -------------------------------------------------------------------

  it('hiển thị thành công sau khi lưu geofence', async () => {
    // GET geofence trả 404 lần đầu, POST mutation thành công
    vi.mocked(fetchApi)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' })
      .mockResolvedValue({ success: true, message: 'OK', data: MOCK_GEOFENCE });

    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });
    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.70 } });

    await waitFor(() =>
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm')
    );

    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });
  });

  it('hiển thị lỗi API khi save thất bại (403 forbidden)', async () => {
    vi.mocked(fetchApi)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' })
      .mockRejectedValue({
        statusCode: 403,
        message: 'Bạn không sở hữu dự án này',
        errorCode: 'FORBIDDEN',
      });

    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.68 } });
    getClickHandler()?.({ latlng: { lat: 10.77, lng: 106.69 } });
    getClickHandler()?.({ latlng: { lat: 10.76, lng: 106.70 } });

    await waitFor(() =>
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm')
    );

    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent(
        'Bạn không sở hữu dự án này'
      );
    });
  });

  // -------------------------------------------------------------------
  // Map render
  // -------------------------------------------------------------------

  it('hiển thị map container khi không loading', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
  });

  it('hiển thị circle bán kính khi polygon có >= 3 điểm', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => {
      expect(screen.getByTestId('circle')).toBeInTheDocument();
    });
  });
});
