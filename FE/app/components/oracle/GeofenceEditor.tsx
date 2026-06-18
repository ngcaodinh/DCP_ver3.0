'use client';

// =============================================================================
// GeofenceEditor — B5: Component vẽ/chỉnh sửa geofence polygon cho Organization.
// Vẽ polygon bằng click event trực tiếp (không dùng leaflet-draw để tránh deps
// và vấn đề tương thích với react-leaflet v4).
// Component này KHÔNG dùng trực tiếp — import qua GeofenceEditorLazy (SSR issue).
// =============================================================================

import { useState, useCallback, useEffect } from 'react';
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

// Sửa lỗi icon Leaflet bị broken khi bundle qua webpack/Next.js
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

type GpsPoint = { lat: number; lng: number };

export type GeofenceEditorProps = {
  projectId: string;
  /** Callback khi lưu geofence thành công — dùng để navigate out hoặc show toast */
  onSaveSuccess?: () => void;
  className?: string;
};

const RADIUS_MIN = 100;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 500;
const AREA_WARNING_KM2 = 100;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Tính diện tích polygon (km²) bằng công thức Shoelace + chuyển đổi độ → km.
 * Chỉ dùng cho hiển thị; Haversine BE mới là nguồn sự thật.
 */
function calcAreaKm2(points: GpsPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].lng * points[j].lat;
    area -= points[j].lng * points[i].lat;
  }
  area = Math.abs(area) / 2;
  const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((meanLat * Math.PI) / 180);
  return area * kmPerDegLat * kmPerDegLng;
}

/** Tính centroid đơn giản (trung bình cộng) — đủ chính xác cho polygon nhỏ < 5 km */
function calcCentroid(points: GpsPoint[]): GpsPoint {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

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

// =============================================================================
// GeofenceEditor — main component
// =============================================================================

export default function GeofenceEditor({
  projectId,
  onSaveSuccess,
  className,
}: GeofenceEditorProps) {
  const { data: existingGeofence, isLoading: loadingGeofence } = useGeofence(projectId);
  const { mutate: upsertGeofence, isPending: isSaving } = useUpsertGeofence();

  const [points, setPoints] = useState<GpsPoint[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState(RADIUS_DEFAULT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Dùng để track đã load từ existing geofence chưa (tránh override khi user đang edit)
  const [initialized, setInitialized] = useState(false);

  // Khi geofence hiện tại load xong → pre-populate form lần đầu
  useEffect(() => {
    if (existingGeofence && !initialized) {
      setPoints(existingGeofence.polygon);
      setRadiusMeters(existingGeofence.radiusMeters);
      setInitialized(true);
    }
    // Không có geofence → enable draw mode mặc định (B5 spec)
    if (!loadingGeofence && !existingGeofence && !initialized) {
      setIsDrawing(true);
      setInitialized(true);
    }
  }, [existingGeofence, loadingGeofence, initialized]);

  const areaKm2 = calcAreaKm2(points);
  const isAreaLarge = areaKm2 > AREA_WARNING_KM2;
  const centroid = points.length >= 3 ? calcCentroid(points) : null;

  const handleAddPoint = useCallback((point: GpsPoint) => {
    setPoints((prev) => [...prev, point]);
    setSaveError(null);
    setSaveSuccess(false);
  }, []);

  const handleDeletePoint = useCallback((idx: number) => {
    setPoints((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleUndo = () => {
    setPoints((prev) => prev.slice(0, -1));
    setSaveError(null);
  };

  const handleReset = () => {
    setPoints([]);
    setIsDrawing(true);
    setSaveError(null);
    setSaveSuccess(false);
    setInitialized(false);
  };

  const handleSave = () => {
    // Validation theo spec B5 — hiển thị error message, không dùng disabled để chặn
    if (points.length < 3) {
      setSaveError('Polygon phải có ít nhất 3 điểm.');
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
        onSuccess: () => {
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

  // Tâm bản đồ mặc định: trung tâm Việt Nam
  const defaultCenter: [number, number] = [16.047, 108.206];
  const mapCenter: [number, number] = existingGeofence
    ? [existingGeofence.centroid.lat, existingGeofence.centroid.lng]
    : defaultCenter;

  const polygonPositions = points.map((p) => [p.lat, p.lng] as [number, number]);

  return (
    <div className={className}>
      {/* Map */}
      <div
        data-testid="geofence-editor-map"
        className={`relative h-96 w-full overflow-hidden rounded-xl border border-slate-200 ${isDrawing ? 'cursor-crosshair' : ''}`}
      >
        {loadingGeofence ? (
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
            scrollWheelZoom
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <MapClickHandler isDrawing={isDrawing} onAddPoint={handleAddPoint} />

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
                pathOptions={{
                  color: '#1d4ed8',
                  fillColor: '#60a5fa',
                  fillOpacity: 1,
                  weight: 2,
                }}
                eventHandlers={{ click: () => handleDeletePoint(idx) }}
              >
                <Popup>
                  <div className="text-xs">
                    <p className="font-semibold text-slate-700">Điểm {idx + 1}</p>
                    <p className="text-slate-500">{`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`}</p>
                    <button
                      onClick={() => handleDeletePoint(idx)}
                      className="mt-1 text-red-500 underline"
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
        {isDrawing && !loadingGeofence && <DrawingBanner />}
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
              Diện tích: {areaKm2.toFixed(2)} km²
            </span>
          )}

          <div className="ml-auto flex gap-2">
            {/* Toggle draw mode */}
            <button
              data-testid="btn-toggle-draw"
              onClick={() => setIsDrawing((d) => !d)}
              disabled={isSaving}
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
              onClick={handleUndo}
              disabled={points.length === 0 || isSaving}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Xóa điểm cuối
            </button>

            {/* Reset */}
            <button
              data-testid="btn-reset"
              onClick={handleReset}
              disabled={isSaving}
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
              onChange={(e) => setRadiusMeters(Number(e.target.value))}
              disabled={isSaving}
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
                if (!isNaN(v)) setRadiusMeters(v);
              }}
              disabled={isSaving}
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
        {saveError && (
          <div
            data-testid="save-error"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {saveError}
          </div>
        )}

        {/* Thành công */}
        {saveSuccess && (
          <div
            data-testid="save-success"
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
          >
            Đã lưu vùng địa lý thành công!
          </div>
        )}

        {/* Save button */}
        <button
          data-testid="btn-save"
          onClick={handleSave}
          disabled={isSaving}
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
