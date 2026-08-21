'use client';

// =============================================================================
// GeofenceEditor — B5: Component vẽ/chỉnh sửa geofence polygon cho Organization.
// Vẽ polygon bằng click event trực tiếp (không dùng leaflet-draw để tránh deps
// và vấn đề tương thích với react-leaflet v4).
// Component này KHÔNG dùng trực tiếp — import qua GeofenceEditorMapLazy (SSR issue).
// =============================================================================

import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
import L from 'leaflet';
import {
  MapContainer,
  TileLayer,
  Polygon,
  Circle,
  CircleMarker,
  Polyline,
  Popup,
  useMapEvents,
  useMap,
} from 'react-leaflet';
import { useGeofence } from '@/app/hooks/useGeofence';
import { useUpsertGeofence } from '@/app/hooks/useUpsertGeofence';
import { fetchApi } from '@/app/utils/apiClient';
import {
  ADMINISTRATIVE_BOUNDARY_ATTRIBUTION,
  ADMINISTRATIVE_BOUNDARY_MAX_ZOOM,
  getAdministrativeBoundaryTileUrl,
  getMapTileUrl,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_TILE_ATTRIBUTION
} from '@/app/utils/mapTileProvider';
import { useAuthCheck } from '@/app/utils/useAuthCheck';
import {
  calculateGeofenceAreaKm2,
  calculateGeofenceCentroid,
  GEOFENCE_AREA_WARNING_KM2,
  MAX_GEOFENCE_POLYGON_POINTS,
  MIN_GEOFENCE_POLYGON_POINTS,
  type GeofencePoint,
  validateGeofencePolygon
} from '@/app/utils/geofenceGeometry';

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

type GpsPoint = GeofencePoint;

type LocationSearchResult = {
  id: number;
  displayName: string;
  point: GpsPoint;
};

export type GeofenceEditorProps = {
  projectId: string;
  /** Callback khi lưu geofence thành công — dùng để navigate out hoặc show toast */
  onSaveSuccess?: () => void;
  className?: string;
};

const RADIUS_MIN = 100;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 500;
const LOCATION_SEARCH_MIN_QUERY_LENGTH = 3;
const LOCATION_SEARCH_RESULT_LIMIT = 5;
const LOCATION_SEARCH_ZOOM = 15;
const LOCATION_SEARCH_MIN_INTERVAL_MS = 1_000;

// =============================================================================
// MAP SUB-COMPONENTS
// =============================================================================

/**
 * Capture click events trên map để thêm điểm.
 * Phải là child của MapContainer vì dùng useMapEvents (cần map context).
 */
function MapClickHandler({
  isDrawing,
  onAddPoint,
}: {
  isDrawing: boolean;
  onAddPoint: (point: GpsPoint) => void;
}) {
  useMapEvents({
    click(e) {
      if (isDrawing) {
        onAddPoint({ lat: e.latlng.lat, lng: e.latlng.lng });
      }
    },
  });
  return null;
}

/** Fit map bounds về polygon khi có dữ liệu — cần useMap nên phải là child component */
function BoundsFitter({ polygon }: { polygon: GpsPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (polygon.length >= 3) {
      const latLngs = polygon.map((p) => L.latLng(p.lat, p.lng));
      map.fitBounds(L.latLngBounds(latLngs), { padding: [32, 32], maxZoom: 15 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // Chỉ fit một lần khi mount (initial load) — không re-fit khi user chỉnh
  return null;
}

/** Di chuyển bản đồ đến địa điểm người dùng đã chọn từ kết quả tìm kiếm. */
function MapViewUpdater({ center }: { center: [number, number] | null }) {
  const map = useMap();

  useEffect(() => {
    if (center) {
      map.setView(center, LOCATION_SEARCH_ZOOM);
    }
  }, [center, map]);

  return null;
}

/** Chuẩn hóa dữ liệu tìm kiếm vị trí không tin cậy từ nhà cung cấp geocoding. */
function parseLocationSearchResults(payload: unknown): LocationSearchResult[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item): LocationSearchResult[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const rawItem = item as Record<string, unknown>;
    const id = Number(rawItem.id);
    const displayName = typeof rawItem.displayName === 'string' ? rawItem.displayName.trim() : '';
    const rawPoint = rawItem.point;

    if (!rawPoint || typeof rawPoint !== 'object') {
      return [];
    }

    const point = rawPoint as Record<string, unknown>;
    const lat = Number(point.lat);
    const lng = Number(point.lng);

    if (!Number.isSafeInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lng) || !displayName) {
      return [];
    }

    return [{ id, displayName, point: { lat, lng } }];
  });
}

// =============================================================================
// UI SUB-COMPONENTS
// =============================================================================

function DrawingBanner() {
  return (
    <div
      data-testid="drawing-banner"
      className="absolute left-1/2 top-3 z-[500] -translate-x-1/2 rounded-full bg-blue-600 px-4 py-1.5 shadow-lg"
    >
      <p className="text-xs font-medium text-white">Click trên bản đồ để thêm điểm</p>
    </div>
  );
}

function AreaWarningBanner() {
  return (
    <div
      data-testid="area-warning-banner"
      className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5"
    >
      <svg
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="text-xs text-amber-700">
        <span className="font-semibold">Diện tích khá lớn.</span> Vui lòng xác nhận đây là ranh giới
        chính xác trước khi lưu.
      </p>
    </div>
  );
}

/** Hiển thị lỗi tải geofence theo status HTTP và chỉ cho retry khi lỗi có thể là tạm thời. */
function GeofenceLoadErrorState({
  statusCode,
  onRetry,
}: {
  statusCode?: number;
  onRetry: () => void;
}) {
  const isUnauthenticated = statusCode === 401;
  const isForbidden = statusCode === 403;
  const message = isUnauthenticated
    ? 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    : isForbidden
      ? 'Bạn không có quyền truy cập geofence của dự án này.'
      : 'Không thể tải geofence. Vui lòng thử lại sau.';

  return (
    <div
      data-testid="geofence-load-error"
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      <p>{message}</p>
      {!isUnauthenticated && !isForbidden ? (
        <button
          data-testid="btn-retry-geofence"
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Thử lại
        </button>
      ) : null}
    </div>
  );
}

// =============================================================================
// GeofenceEditor — main component
// =============================================================================

/** Render editor geofence client-only với draft cục bộ và trạng thái API đã được phân loại. */
export default function GeofenceEditor({
  projectId,
  onSaveSuccess,
  className,
}: GeofenceEditorProps) {
  const { isLoggedIn } = useAuthCheck();
  const {
    data: existingGeofence,
    error: geofenceError,
    isLoading: loadingGeofence,
    refetch: refetchGeofence
  } = useGeofence(isLoggedIn ? projectId : undefined);
  const { mutate: upsertGeofence, isPending: isSaving } = useUpsertGeofence();

  const [points, setPoints] = useState<GpsPoint[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState(RADIUS_DEFAULT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [initializedProjectId, setInitializedProjectId] = useState<string | null>(null);
  const [locationSearchQuery, setLocationSearchQuery] = useState('');
  const [locationSearchResults, setLocationSearchResults] = useState<LocationSearchResult[]>([]);
  const [locationSearchError, setLocationSearchError] = useState<string | null>(null);
  const [isLocationSearching, setIsLocationSearching] = useState(false);
  const [searchedMapCenter, setSearchedMapCenter] = useState<[number, number] | null>(null);
  const lastLocationSearchAtRef = useRef(0);
  const geofenceErrorStatusCode = geofenceError?.statusCode;
  // Không cho thao tác với draft của project trước khi dữ liệu project hiện tại đã nạp xong.
  const isGeofenceInitializing = isLoggedIn && (loadingGeofence || initializedProjectId !== projectId);
  const isEditorInteractionDisabled = isSaving || isGeofenceInitializing;

  useEffect(() => {
    if (initializedProjectId !== null && initializedProjectId !== projectId) {
      setSaveError(null);
      setSaveSuccess(false);
    }

    if (loadingGeofence || initializedProjectId === projectId) {
      return;
    }

    if (existingGeofence) {
      setPoints(existingGeofence.polygon);
      setRadiusMeters(existingGeofence.radiusMeters);
      setIsDrawing(false);
      setInitializedProjectId(projectId);
      return;
    }

    if (geofenceErrorStatusCode === 404) {
      setPoints([]);
      setRadiusMeters(RADIUS_DEFAULT);
      setIsDrawing(true);
      setInitializedProjectId(projectId);
    }
  }, [existingGeofence, geofenceErrorStatusCode, initializedProjectId, loadingGeofence, projectId]);

  const areaKm2 = calculateGeofenceAreaKm2(points);
  const isAreaLarge = areaKm2 > GEOFENCE_AREA_WARNING_KM2;
  const centroid = calculateGeofenceCentroid(points);

  /** Thêm điểm geofence mới và chặn vượt giới hạn polygon để tránh payload quá lớn. */
  const handleAddPoint = useCallback((point: GpsPoint) => {
    if (isEditorInteractionDisabled) {
      return;
    }
    if (points.length >= MAX_GEOFENCE_POLYGON_POINTS) {
      setSaveError(`Polygon chỉ được có tối đa ${MAX_GEOFENCE_POLYGON_POINTS} điểm.`);
      return;
    }
    const nextPoints = [...points, point];
    setPoints(nextPoints);
    setSaveError(
      nextPoints.length >= MIN_GEOFENCE_POLYGON_POINTS
        ? validateGeofencePolygon(nextPoints)
        : null
    );
    setSaveSuccess(false);
  }, [isEditorInteractionDisabled, points]);

  /** Xóa một điểm và cập nhật ngay thông báo hợp lệ của draft còn lại. */
  const handleDeletePoint = useCallback((idx: number) => {
    if (isEditorInteractionDisabled) {
      return;
    }
    const nextPoints = points.filter((_, pointIndex) => pointIndex !== idx);
    setPoints(nextPoints);
    setSaveError(
      nextPoints.length >= MIN_GEOFENCE_POLYGON_POINTS
        ? validateGeofencePolygon(nextPoints)
        : null
    );
    setSaveSuccess(false);
  }, [isEditorInteractionDisabled, points]);

  /** Xóa đỉnh vừa thêm gần nhất để người dùng điều chỉnh draft nhanh. */
  const handleUndo = useCallback(() => {
    if (isEditorInteractionDisabled) {
      return;
    }
    const nextPoints = points.slice(0, -1);
    setPoints(nextPoints);
    setSaveError(
      nextPoints.length >= MIN_GEOFENCE_POLYGON_POINTS
        ? validateGeofencePolygon(nextPoints)
        : null
    );
    setSaveSuccess(false);
  }, [isEditorInteractionDisabled, points]);

  /** Xóa draft hiện tại và giữ cờ khởi tạo để không tự nạp lại polygon đã lưu. */
  const handleReset = useCallback(() => {
    if (isEditorInteractionDisabled) {
      return;
    }
    setPoints([]);
    setIsDrawing(true);
    setSaveError(null);
    setSaveSuccess(false);
  }, [isEditorInteractionDisabled]);

  /** Cập nhật bán kính draft và bỏ trạng thái đã lưu vì dữ liệu local đã thay đổi. */
  const handleRadiusChange = useCallback((nextRadiusMeters: number) => {
    if (isEditorInteractionDisabled) {
      return;
    }
    setRadiusMeters(nextRadiusMeters);
    setSaveSuccess(false);
  }, [isEditorInteractionDisabled]);

  /** Validate và gửi polygon geofence lên API khi người dùng lưu vùng địa lý. */
  const handleSave = () => {
    if (isEditorInteractionDisabled) {
      return;
    }
    const polygonValidationError = validateGeofencePolygon(points);
    if (polygonValidationError) {
      setSaveError(polygonValidationError);
      return;
    }
    if (radiusMeters > RADIUS_MAX) {
      setSaveError('Bán kính tối đa 2000m.');
      return;
    }
    if (radiusMeters < RADIUS_MIN) {
      setSaveError(`Bán kính tối thiểu ${RADIUS_MIN}m.`);
      return;
    }
    setSaveError(null);
    setSaveSuccess(false);

    upsertGeofence(
      { projectId, polygon: points, radiusMeters },
      {
        onSuccess: (geofence) => {
          // Lấy lại polygon/radius từ response authoritative để UI luôn phản ánh bản đã persist.
          setPoints(geofence.polygon);
          setRadiusMeters(geofence.radiusMeters);
          setIsDrawing(false);
          setSaveSuccess(true);
          onSaveSuccess?.();
        },
        onError: (err) => {
          setSaveError(err.message ?? 'Không thể lưu vùng địa lý. Vui lòng thử lại.');
        },
      }
    );
  };

  /** Gọi lại GET geofence sau lỗi mạng hoặc lỗi máy chủ có thể hồi phục. */
  const handleRetryGeofence = useCallback(() => {
    void refetchGeofence();
  }, [refetchGeofence]);

  /** Tìm địa điểm theo thao tác chủ động của người dùng để định vị vị trí bắt đầu vẽ geofence. */
  const handleLocationSearch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const query = locationSearchQuery.trim();

    if (query.length < LOCATION_SEARCH_MIN_QUERY_LENGTH) {
      setLocationSearchResults([]);
      setLocationSearchError(`Nhập ít nhất ${LOCATION_SEARCH_MIN_QUERY_LENGTH} ký tự để tìm địa điểm.`);
      return;
    }

    const now = Date.now();
    if (now - lastLocationSearchAtRef.current < LOCATION_SEARCH_MIN_INTERVAL_MS) {
      setLocationSearchError('Vui lòng chờ một giây trước khi tìm lại.');
      return;
    }
    lastLocationSearchAtRef.current = now;

    setIsLocationSearching(true);
    setLocationSearchError(null);

    try {
      const searchParameters = new URLSearchParams({
        q: query,
        limit: String(LOCATION_SEARCH_RESULT_LIMIT)
      });
      const searchUrl = `/api/location-search?${searchParameters.toString()}`;

      const response = await fetchApi<unknown>(searchUrl);
      const searchResults = parseLocationSearchResults(response.data);
      setLocationSearchResults(searchResults);
      if (searchResults.length === 0) {
        setLocationSearchError('Không tìm thấy địa điểm phù hợp. Hãy thử từ khóa chi tiết hơn.');
      }
    } catch {
      setLocationSearchResults([]);
      setLocationSearchError('Không thể tìm địa điểm lúc này. Vui lòng thử lại.');
    } finally {
      setIsLocationSearching(false);
    }
  };

  /** Chọn một kết quả để đưa tâm bản đồ đến vị trí đó trước khi người dùng vẽ polygon. */
  const handleSelectLocationSearchResult = (result: LocationSearchResult): void => {
    setSearchedMapCenter([result.point.lat, result.point.lng]);
    setLocationSearchQuery(result.displayName);
    setLocationSearchResults([]);
    setLocationSearchError(null);
  };

  if (geofenceError && geofenceErrorStatusCode !== 404) {
    return <GeofenceLoadErrorState statusCode={geofenceErrorStatusCode} onRetry={handleRetryGeofence} />;
  }

  if (!isLoggedIn) {
    return <GeofenceLoadErrorState statusCode={401} onRetry={handleRetryGeofence} />;
  }

  // Tâm bản đồ mặc định: trung tâm Việt Nam
  const defaultCenter: [number, number] = [16.047, 108.206];
  const mapCenter: [number, number] = existingGeofence
    ? [existingGeofence.centroid.lat, existingGeofence.centroid.lng]
    : defaultCenter;

  const polygonPositions = points.map((p) => [p.lat, p.lng] as [number, number]);

  return (
    <div className={className}>
      <form
        data-testid="location-search-control"
        onSubmit={handleLocationSearch}
        className="mb-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label htmlFor="location-search" className="mb-1 block text-sm font-semibold text-slate-800">Tìm địa điểm</label>
        <div className="flex gap-2">
          <input
            id="location-search"
            data-testid="location-search-input"
            value={locationSearchQuery}
            onChange={(event) => setLocationSearchQuery(event.target.value)}
            placeholder="Ví dụ: Tân An, Cần Thơ"
            disabled={isLocationSearching || isGeofenceInitializing}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-blue-500 focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-100"
          />
          <button
            data-testid="btn-location-search"
            type="submit"
            disabled={isLocationSearching || isGeofenceInitializing}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLocationSearching ? 'Đang tìm...' : 'Tìm'}
          </button>
        </div>
        {locationSearchError ? <p role="alert" className="mt-2 text-xs text-red-600">{locationSearchError}</p> : null}
        {locationSearchResults.length > 0 ? (
          <ul data-testid="location-search-results" className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            {locationSearchResults.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => handleSelectLocationSearchResult(result)}
                  className="w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 last:border-b-0 hover:bg-blue-50"
                >
                  {result.displayName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-slate-500">Chọn kết quả để đưa bản đồ đến vị trí đó.</p>
        <a
          href="https://sapnhap.bando.com.vn/"
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs font-medium text-blue-700 underline hover:text-blue-900"
        >
          Mở bản đồ địa giới chính thức của 34 tỉnh/thành sau sáp nhập
        </a>
      </form>

      {/* Map */}
      <div
        data-testid="geofence-editor-map"
        className={`relative h-96 w-full overflow-hidden rounded-xl border border-slate-200 ${isDrawing && !isEditorInteractionDisabled ? 'cursor-crosshair' : ''}`}
      >
        {isGeofenceInitializing ? (
          <div className="flex h-full w-full animate-pulse items-center justify-center bg-slate-100">
            <div className="space-y-2 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-slate-200" />
              <div className="h-3 w-24 rounded bg-slate-200" />
            </div>
          </div>
        ) : (
          <MapContainer
            center={mapCenter}
            zoom={existingGeofence ? 14 : 6}
            minZoom={MAP_MIN_ZOOM}
            maxZoom={MAP_MAX_ZOOM}
            scrollWheelZoom
            className="h-full w-full"
          >
        <TileLayer
          attribution={MAP_TILE_ATTRIBUTION}
          url={getMapTileUrl()}
          minZoom={MAP_MIN_ZOOM}
          maxZoom={MAP_MAX_ZOOM}
          maxNativeZoom={MAP_MAX_ZOOM}
          noWrap
        />
            <TileLayer
              attribution={ADMINISTRATIVE_BOUNDARY_ATTRIBUTION}
              url={getAdministrativeBoundaryTileUrl()}
              minZoom={MAP_MIN_ZOOM}
              maxZoom={MAP_MAX_ZOOM}
              maxNativeZoom={ADMINISTRATIVE_BOUNDARY_MAX_ZOOM}
              opacity={0.9}
              zIndex={200}
              noWrap
            />

            <MapClickHandler
              isDrawing={isDrawing && !isEditorInteractionDisabled}
              onAddPoint={handleAddPoint}
            />

            <MapViewUpdater center={searchedMapCenter} />

            {/* Fit bounds về polygon hiện tại khi load lần đầu */}
            {existingGeofence && <BoundsFitter polygon={existingGeofence.polygon} />}

            {/* Polygon đã hoàn chỉnh (>= 3 điểm) */}
            {points.length >= 3 && (
              <Polygon
                positions={polygonPositions}
                pathOptions={{
                  color: '#2563eb',
                  fillColor: '#3b82f6',
                  fillOpacity: 0.08,
                  weight: 2,
                }}
              />
            )}

            {/* Circle bán kính Haversine từ centroid */}
            {centroid && (
              <Circle
                center={[centroid.lat, centroid.lng]}
                radius={radiusMeters}
                pathOptions={{
                  color: '#2563eb',
                  fillColor: '#3b82f6',
                  fillOpacity: 0.04,
                  weight: 1.5,
                  dashArray: '6 4',
                }}
              />
            )}

            {/* Điểm polygon — click để xóa */}
            {points.map((p, idx) => (
              <CircleMarker
                key={idx}
                center={[p.lat, p.lng]}
                radius={7}
                bubblingMouseEvents={false}
                pathOptions={{
                  color: '#1d4ed8',
                  fillColor: '#60a5fa',
                  fillOpacity: 1,
                  weight: 2,
                }}
                eventHandlers={isEditorInteractionDisabled ? undefined : { click: () => handleDeletePoint(idx) }}
              >
                <Popup>
                  <div className="text-xs">
                    <p className="font-semibold text-slate-700">Điểm {idx + 1}</p>
                    <p className="text-slate-500">{`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`}</p>
                    <button
                      type="button"
                      onClick={() => handleDeletePoint(idx)}
                      disabled={isEditorInteractionDisabled}
                      className="mt-1 text-red-500 underline disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Xóa điểm này
                    </button>
                  </div>
                </Popup>
              </CircleMarker>
            ))}

            {/* Đường nối điểm cuối → đầu khi đang vẽ dở (visual guide) */}
            {isDrawing && points.length >= 2 && (
              <Polyline
                positions={[...polygonPositions, polygonPositions[0]]}
                pathOptions={{ color: '#93c5fd', weight: 1.5, dashArray: '4 4' }}
              />
            )}
          </MapContainer>
        )}

        {/* Banner "đang vẽ" */}
        {isDrawing && !isGeofenceInitializing && <DrawingBanner />}
      </div>

      {/* Controls */}
      <div className="mt-4 space-y-4">
        {/* Thống kê & actions */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="point-count"
            className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
          >
            {points.length} điểm
          </span>

          {points.length >= 3 && (
            <span
              data-testid="area-display"
              className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
            >
              Diện tích ước tính: {areaKm2.toFixed(2)} km²
            </span>
          )}

          <div className="ml-auto flex gap-2">
            {/* Toggle draw mode */}
            <button
              data-testid="btn-toggle-draw"
              type="button"
              onClick={() => setIsDrawing((d) => !d)}
              disabled={isEditorInteractionDisabled}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isDrawing
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'border border-blue-300 bg-white text-blue-700 hover:bg-blue-50'
              }`}
            >
              {isDrawing ? 'Dừng vẽ' : 'Tiếp tục vẽ'}
            </button>

            {/* Undo last point */}
            <button
              data-testid="btn-undo"
              type="button"
              onClick={handleUndo}
              disabled={points.length === 0 || isEditorInteractionDisabled}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Xóa điểm cuối
            </button>

            {/* Reset */}
            <button
              data-testid="btn-reset"
              type="button"
              onClick={handleReset}
              disabled={isEditorInteractionDisabled}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Vẽ lại
            </button>
          </div>
        </div>

        {/* Bán kính Haversine */}
        <div>
          <label htmlFor="radius-slider" className="mb-1.5 block text-sm font-medium text-slate-700">
            Bán kính xác minh:{' '}
            <span data-testid="radius-value" className="font-semibold text-blue-700">
              {radiusMeters} m
            </span>
          </label>
          <div className="flex items-center gap-3">
            <input
              id="radius-slider"
              data-testid="radius-slider"
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={50}
              value={radiusMeters}
              onChange={(e) => handleRadiusChange(Number(e.target.value))}
              disabled={isEditorInteractionDisabled}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-blue-600"
            />
            <input
              data-testid="radius-input"
              type="number"
              min={RADIUS_MIN}
              value={radiusMeters}
              onChange={(e) => {
                // Không clamp tại đây — để user nhập tự do, validation ở handleSave
                const v = Number(e.target.value);
                if (!isNaN(v)) handleRadiusChange(v);
              }}
              disabled={isEditorInteractionDisabled}
              className={`w-20 rounded-lg border px-2 py-1 text-center text-sm focus:outline-none disabled:opacity-50 ${
                radiusMeters > RADIUS_MAX || radiusMeters < RADIUS_MIN
                  ? 'border-red-400 focus:border-red-500'
                  : 'border-slate-300 focus:border-blue-500'
              }`}
            />
            <span className="text-xs text-slate-500">m</span>
          </div>
          {radiusMeters > RADIUS_MAX && (
            <p data-testid="radius-error" className="mt-1 text-xs font-medium text-red-600">
              Bán kính tối đa 2000m.
            </p>
          )}
          {radiusMeters < RADIUS_MIN && (
            <p data-testid="radius-error" className="mt-1 text-xs font-medium text-red-600">
              Bán kính tối thiểu {RADIUS_MIN}m.
            </p>
          )}
          {radiusMeters >= RADIUS_MIN && radiusMeters <= RADIUS_MAX && (
            <p className="mt-1 text-xs text-slate-400">
              Phạm vi {RADIUS_MIN}m – {RADIUS_MAX}m • Mặc định 500m
            </p>
          )}
        </div>

        {/* Cảnh báo diện tích lớn */}
        {isAreaLarge && <AreaWarningBanner />}

        {/* Lỗi validation / API */}
        {saveError && !isGeofenceInitializing && (
          <div
            data-testid="save-error"
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {saveError}
          </div>
        )}

        {/* Thành công */}
        {saveSuccess && !isGeofenceInitializing && (
          <div
            data-testid="save-success"
            role="alert"
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
          >
            Đã lưu vùng địa lý thành công!
          </div>
        )}

        {/* Save button */}
        <button
          data-testid="btn-save"
          type="button"
          onClick={handleSave}
          disabled={isEditorInteractionDisabled}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Đang lưu…' : 'Lưu vùng địa lý'}
        </button>

        {/* Hướng dẫn */}
        <ul className="space-y-1 text-xs text-slate-400">
          <li>• Bật <strong className="text-slate-500">Tiếp tục vẽ</strong> rồi click trên bản đồ để thêm điểm</li>
          <li>• Click vào điểm đã vẽ để xóa điểm đó</li>
          <li>• Polygon cần tối thiểu 3 điểm để lưu</li>
          <li>• Bán kính xác định vùng ảnh minh chứng được chấp nhận (Haversine)</li>
        </ul>
      </div>
    </div>
  );
}
