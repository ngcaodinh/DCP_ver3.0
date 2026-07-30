/**
 * Tests cho GeofenceEditor + useUpsertGeofence (B5).
 * react-leaflet bị mock hoàn toàn vì Leaflet cần DOM thật.
 * Tập trung vào: load existing geofence, vẽ polygon, validation,
 * radius input, save success/error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  TileLayer: ({ url }: { url: string }) => <div data-testid="tile-layer" data-url={url} />,
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

import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import L from 'leaflet';
import GeofenceEditor from '@/app/components/oracle/GeofenceEditor';

// =============================================================================
// HELPERS
// =============================================================================

type ClickEventArg = { latlng: { lat: number; lng: number } };
type ClickHandler = (e: ClickEventArg) => void;

/** Tạo Promise có thể chủ động resolve để kiểm tra UI trong lúc mutation đang pending. */
function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

/** Render component với QueryClient riêng và hỗ trợ rerender mà không rò cache giữa các test. */
function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const renderResult = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

  return {
    queryClient: client,
    ...renderResult,
    rerender: (nextUi: React.ReactElement) =>
      renderResult.rerender(<QueryClientProvider client={client}>{nextUi}</QueryClientProvider>)
  };
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

/** Gọi callback Leaflet trong act để đồng bộ state React như một click thực của người dùng. */
function triggerMapClick(getClickHandler: () => ClickHandler | null, lat: number, lng: number): void {
  const clickHandler = getClickHandler();
  if (!clickHandler) {
    throw new Error('Không tìm thấy click handler của Leaflet trong test.');
  }

  act(() => {
    clickHandler({ latlng: { lat, lng } });
  });
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

/** Render một geofence đã persist và chờ thông báo Save thành công để test lifecycle draft. */
async function renderSavedExistingGeofence(): Promise<void> {
  vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
  renderWithQuery(<GeofenceEditor projectId="project-abc" />);
  await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

  fireEvent.click(screen.getByTestId('btn-save'));
  await waitFor(() => expect(screen.getByTestId('save-success')).toBeInTheDocument());
}

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

  it('khóa tương tác và không lưu draft cũ khi project đổi trong lúc tải', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({ success: true, message: '', data: MOCK_GEOFENCE })
      .mockReturnValueOnce(new Promise(() => {}));

    const { rerender } = renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

    rerender(<GeofenceEditor projectId="project-def" />);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('btn-toggle-draw')).toBeDisabled();
    expect(screen.getByTestId('btn-undo')).toBeDisabled();
    expect(screen.getByTestId('btn-reset')).toBeDisabled();
    expect(screen.getByTestId('radius-slider')).toBeDisabled();
    expect(screen.getByTestId('radius-input')).toBeDisabled();
    expect(screen.getByTestId('btn-save')).toBeDisabled();

    fireEvent.click(screen.getByTestId('btn-save'));
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it('không cho Leaflet thay đổi polygon trong lúc Save đang pending', async () => {
    const pendingSave = createDeferred<{ success: true; message: string; data: typeof MOCK_GEOFENCE }>();
    vi.mocked(fetchApi)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' })
      .mockReturnValueOnce(pendingSave.promise);
    const { getClickHandler } = setupMapClickCapture();
    const { queryClient } = renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => screen.getByTestId('drawing-banner'));
    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);
    triggerMapClick(getClickHandler, 10.76, 106.70);
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => expect(screen.getByTestId('btn-save')).toBeDisabled());

    fireEvent.click(screen.getAllByTestId('circle-marker')[0]);
    expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');
    triggerMapClick(getClickHandler, 10.78, 106.71);
    expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');

    pendingSave.resolve({ success: true, message: 'OK', data: MOCK_GEOFENCE });
    await waitFor(() => expect(screen.getByTestId('save-success')).toBeInTheDocument());
    expect(queryClient.getQueryData(['geofence', 'project-abc'])).toEqual(MOCK_GEOFENCE);
    expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');
  });

  it('xóa thông báo lưu thành công khi người dùng đổi radius', async () => {
    await renderSavedExistingGeofence();

    fireEvent.change(screen.getByTestId('radius-slider'), { target: { value: '1000' } });
    expect(screen.getByTestId('radius-value')).toHaveTextContent('1000 m');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
  });

  it('xóa thông báo lưu thành công khi người dùng xóa đỉnh marker', async () => {
    await renderSavedExistingGeofence();

    fireEvent.click(screen.getAllByTestId('circle-marker')[0]);
    expect(screen.getByTestId('point-count')).toHaveTextContent('2 điểm');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
  });

  it('xóa thông báo lưu thành công khi người dùng thêm đỉnh mới', async () => {
    const { getClickHandler } = setupMapClickCapture();
    await renderSavedExistingGeofence();

    fireEvent.click(screen.getByTestId('btn-toggle-draw'));
    triggerMapClick(getClickHandler, 10.78, 106.71);

    expect(screen.getByTestId('point-count')).toHaveTextContent('4 điểm');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
  });

  it('xóa thông báo lưu thành công khi người dùng undo draft', async () => {
    await renderSavedExistingGeofence();

    fireEvent.click(screen.getByTestId('btn-undo'));
    expect(screen.getByTestId('point-count')).toHaveTextContent('2 điểm');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
  });

  it('xóa thông báo lưu thành công khi người dùng reset draft', async () => {
    await renderSavedExistingGeofence();

    fireEvent.click(screen.getByTestId('btn-reset'));
    expect(screen.getByTestId('point-count')).toHaveTextContent('0 điểm');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
  });

  it('xóa feedback của project cũ khi chuyển sang project mới', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({ success: true, message: '', data: MOCK_GEOFENCE })
      .mockResolvedValueOnce({ success: true, message: '', data: MOCK_GEOFENCE })
      .mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => expect(screen.getByTestId('save-success')).toBeInTheDocument());

    rerender(<GeofenceEditor projectId="project-def" />);
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByTestId('save-success')).not.toBeInTheDocument());
  });

  it('xóa lỗi Save của project cũ khi chuyển sang project mới', async () => {
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({ success: true, message: '', data: MOCK_GEOFENCE })
      .mockRejectedValueOnce({
        statusCode: 403,
        message: 'Bạn không sở hữu dự án này',
        errorCode: 'FORBIDDEN',
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => expect(screen.getByTestId('save-error')).toBeInTheDocument());

    rerender(<GeofenceEditor projectId="project-def" />);
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('save-error')).not.toBeInTheDocument();
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

  it.each([
    [401, 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'],
    [403, 'Bạn không có quyền truy cập geofence của dự án này.']
  ])('không mở editor rỗng khi GET trả %i', async (statusCode, expectedMessage) => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode, message: expectedMessage, errorCode: 'REQUEST_ERROR' });

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => {
      expect(screen.getByTestId('geofence-load-error')).toHaveTextContent(expectedMessage);
    });
    expect(screen.queryByTestId('geofence-editor-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-retry-geofence')).not.toBeInTheDocument();
  });

  it('hiển thị retry thay vì editor rỗng khi GET lỗi máy chủ', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 500, message: 'Server error', errorCode: 'INTERNAL_ERROR' });

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(
      () => expect(screen.getByTestId('btn-retry-geofence')).toBeInTheDocument(),
      { timeout: 3000 }
    );
    const fetchCallCountBeforeRetry = vi.mocked(fetchApi).mock.calls.length;
    fireEvent.click(screen.getByTestId('btn-retry-geofence'));
    await waitFor(
      () => expect(vi.mocked(fetchApi).mock.calls.length).toBeGreaterThan(fetchCallCountBeforeRetry),
      { timeout: 3000 }
    );
  });

  it('encode projectId trước khi tạo URL GET geofence', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' });

    renderWithQuery(<GeofenceEditor projectId="project/a" />);

    await waitFor(() => expect(screen.getByTestId('drawing-banner')).toBeInTheDocument());
    expect(buildApiUrl).toHaveBeenCalledWith('/api/oracle/geofence/project%2Fa');
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
    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);
    triggerMapClick(getClickHandler, 10.76, 106.70);

    await waitFor(() => {
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');
    });
  });

  it('toggle draw mode khi click nút "Tiếp tục vẽ"', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => expect(screen.getByTestId('radius-value')).toHaveTextContent('800 m'));

    const btn = screen.getByTestId('btn-toggle-draw');
    expect(btn).toHaveTextContent('Tiếp tục vẽ');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveTextContent('Dừng vẽ'));
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

    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);

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

    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);

    fireEvent.click(screen.getByTestId('btn-reset'));

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('0 điểm'));
  });

  it('reset polygon đã lưu không tự nạp lại draft cũ trước khi người dùng Save', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));
    fireEvent.click(screen.getByTestId('btn-reset'));
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('0 điểm'));
    expect(screen.getByTestId('drawing-banner')).toBeInTheDocument();
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
    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);

    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('2 điểm'));

    // Nút Save không bị disabled — click được và show error
    expect(screen.getByTestId('btn-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent('Polygon phải có ít nhất 3 điểm');
    });
  });

  it('chặn save khi polygon tự cắt và giữ nguyên draft người dùng vừa vẽ', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    triggerMapClick(getClickHandler, 0, 0);
    triggerMapClick(getClickHandler, 1, 1);
    triggerMapClick(getClickHandler, 0, 1);
    triggerMapClick(getClickHandler, 1, 0);

    await waitFor(() => expect(screen.getByTestId('save-error')).toHaveTextContent('Polygon không được tự cắt'));
    fireEvent.click(screen.getByTestId('btn-save'));

    expect(screen.getByTestId('point-count')).toHaveTextContent('4 điểm');
    expect(fetchApi).toHaveBeenCalledTimes(1);
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
    triggerMapClick(getClickHandler, 10.0, 106.0);
    triggerMapClick(getClickHandler, 20.0, 106.0);
    triggerMapClick(getClickHandler, 20.0, 116.0);

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
    const { queryClient } = renderWithQuery(<GeofenceEditor projectId="project-abc" />);
    await waitFor(() => screen.getByTestId('drawing-banner'));

    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);
    triggerMapClick(getClickHandler, 10.76, 106.70);

    await waitFor(() =>
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm')
    );

    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });
    expect(queryClient.getQueryData(['geofence', 'project-abc'])).toEqual(MOCK_GEOFENCE);
  });

  it('encode projectId và gửi đúng body khi Save', async () => {
    const projectId = 'project/a';
    const polygon = [
      { lat: 10.76, lng: 106.68 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 },
    ];
    const savedGeofence = { ...MOCK_GEOFENCE, projectId, polygon, radiusMeters: 500 };
    vi.mocked(fetchApi)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found', errorCode: 'NOT_FOUND' })
      .mockResolvedValueOnce({ success: true, message: 'OK', data: savedGeofence });
    const { getClickHandler } = setupMapClickCapture();

    renderWithQuery(<GeofenceEditor projectId={projectId} />);
    await waitFor(() => screen.getByTestId('drawing-banner'));
    polygon.forEach(point => triggerMapClick(getClickHandler, point.lat, point.lng));
    await waitFor(() => expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm'));

    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => expect(screen.getByTestId('save-success')).toBeInTheDocument());

    expect(buildApiUrl).toHaveBeenLastCalledWith('/api/oracle/geofence/project%2Fa');
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/oracle/geofence/project%2Fa',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token' },
        body: JSON.stringify({ polygon, radiusMeters: 500 })
      })
    );
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

    triggerMapClick(getClickHandler, 10.76, 106.68);
    triggerMapClick(getClickHandler, 10.77, 106.69);
    triggerMapClick(getClickHandler, 10.76, 106.70);

    await waitFor(() =>
      expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm')
    );

    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent(
        'Bạn không sở hữu dự án này'
      );
    });
    expect(screen.getByTestId('point-count')).toHaveTextContent('3 điểm');
    expect(screen.queryByTestId('save-success')).not.toBeInTheDocument();
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

  it.each([100, 2000])('chấp nhận radius ở biên UI: %i m', async radiusMeters => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => expect(screen.getByTestId('radius-value')).toHaveTextContent('800 m'));
    fireEvent.change(screen.getByTestId('radius-input'), { target: { value: String(radiusMeters) } });

    expect(screen.getByTestId('radius-value')).toHaveTextContent(`${radiusMeters} m`);
    expect(screen.queryByTestId('radius-error')).not.toBeInTheDocument();
  });

  it('chỉ sử dụng endpoint tile proxy nội bộ, không dùng tile provider bên thứ ba', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: MOCK_GEOFENCE });
    renderWithQuery(<GeofenceEditor projectId="project-abc" />);

    await waitFor(() => expect(screen.getByTestId('tile-layer')).toBeInTheDocument());
    const tileUrl = screen.getByTestId('tile-layer').getAttribute('data-url');
    expect(tileUrl).toContain('/api/tiles/{z}/{x}/{y}.png');
    expect(tileUrl).not.toContain('tile.openstreetmap.org');
    expect(tileUrl).not.toContain('unpkg.com');
    expect(vi.mocked(L.Icon.Default.mergeOptions)).not.toHaveBeenCalled();
  });
});
