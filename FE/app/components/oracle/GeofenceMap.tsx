'use client';

// =============================================================================
// GeofenceMap — B3: Bản đồ Leaflet review geofence + evidence markers cho Admin.
// Component này KHÔNG dùng trực tiếp — import qua GeofenceMapLazy để tránh SSR lỗi.
// Leaflet là DOM-only library, cần next/dynamic ssr:false ở wrapper.
//
// Nguồn dữ liệu geofence (theo thứ tự ưu tiên):
//  1. Prop `snapshot` (khác undefined) — snapshot bất biến lúc Oracle verify (B3-BE-01).
//     `snapshot = null` nghĩa là record cũ thiếu snapshot → hiển thị banner cảnh báo,
//     KHÔNG vẽ current geofence để tránh giải thích sai verdict lịch sử.
//  2. Nếu không truyền `snapshot` (undefined) — fetch current geofence qua useGeofence
//     (giữ tương thích cho caller không cần dữ liệu lịch sử).
// =============================================================================

import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Polygon, Circle, CircleMarker, Popup, useMap } from 'react-leaflet';
import { useGeofence } from '@/app/hooks/useGeofence';

// =============================================================================
// TYPES
// =============================================================================

export type GeofenceMarkerStatus = 'VALID' | 'INVALID' | 'NO_GPS';

export type LatLng = { lat: number; lng: number };

/**
 * Snapshot geofence bất biến lúc Oracle verify (khớp GeofenceSnapshot ở BE).
 * Dùng để review đúng polygon/centroid/radius lịch sử, không phụ thuộc geofence hiện tại.
 */
export type GeofenceSnapshotView = {
  polygon: LatLng[];
  centroid: LatLng;
  radiusMeters: number;
};

/**
 * Marker cho một ảnh minh chứng đã được Oracle xác minh.
 * `coordinate = null` khi status NO_GPS (ảnh không có EXIF GPS) — không vẽ pin địa lý giả.
 */
export type GeofenceMarker = {
  /** Định danh ổn định (thường là verificationId hoặc evidenceCid). */
  id: string;
  /** Tọa độ GPS thật từ EXIF; null khi NO_GPS. */
  coordinate: LatLng | null;
  /** Verdict Oracle: xanh=VALID, đỏ=INVALID, vàng=NO_GPS. */
  status: GeofenceMarkerStatus;
  /** CID ảnh minh chứng — chỉ hiển thị dạng text, không tự tải gateway trực tiếp từ browser reviewer. */
  evidenceCid?: string;
  /** URL thumbnail đã được caller/proxy kiểm soát; nếu thiếu thì popup không render ảnh. */
  evidenceThumbnailUrl?: string;
  /** Khoảng cách Haversine (m) do Oracle tính; null khi NO_GPS. */
  distanceMeters?: number | null;
  /** Thời điểm ảnh được xử lý/verify (ISO 8601). */
  capturedAt?: string;
  /** Thông điệp verdict do Oracle sinh ra (hiển thị trong popup). */
  verificationMessage?: string;
};

export type GeofenceMapProps = {
  projectId: string;
  /**
   * Snapshot geofence bất biến. Truyền `null` cho record cũ thiếu snapshot (hiện banner cảnh báo).
   * Bỏ trống (undefined) để component tự fetch current geofence qua useGeofence.
   */
  snapshot?: GeofenceSnapshotView | null;
  /** Danh sách marker từ ảnh minh chứng. */
  markers?: GeofenceMarker[];
  className?: string;
};

const EMPTY_GEOFENCE_MARKERS: GeofenceMarker[] = [];

// =============================================================================
// HELPERS
// =============================================================================

const MARKER_COLORS: Record<GeofenceMarkerStatus, { color: string; fillColor: string; label: string }> = {
  VALID:   { color: '#16a34a', fillColor: '#22c55e', label: 'Trong vùng' },
  INVALID: { color: '#dc2626', fillColor: '#ef4444', label: 'Ngoài vùng' },
  NO_GPS:  { color: '#d97706', fillColor: '#f59e0b', label: 'Không có GPS' },
};

/** Định dạng tọa độ 6 chữ số thập phân để hiển thị nhất quán trong popup. */
function formatCoordinate(coordinate: LatLng): string {
  return `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`;
}

/** Định dạng timestamp ISO sang giờ Việt Nam; trả chuỗi gốc nếu parse lỗi. */
function formatTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return isoTimestamp;
  return parsed.toLocaleString('vi-VN', { hour12: false });
}

/**
 * Fit map bounds về polygon geofence + mọi marker có tọa độ thật.
 * Cần useMap nên phải là child component của MapContainer.
 * Marker INVALID ở xa vẫn được đưa vào viewport để reviewer thấy toàn cảnh.
 */
function BoundsFitter({ points, pointsKey }: { points: LatLng[]; pointsKey: string }) {
  const map = useMap();
  const lastFitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (points.length === 0) return;
    if (lastFitKeyRef.current === pointsKey) return;

    lastFitKeyRef.current = pointsKey;
    if (points.length === 1) {
      map.setView([points[0]!.lat, points[0]!.lng], 15);
      return;
    }
    const latLngs = points.map((p) => L.latLng(p.lat, p.lng));
    map.fitBounds(L.latLngBounds(latLngs), { padding: [24, 24], maxZoom: 16 });
  }, [map, points, pointsKey]);
  return null;
}

// =============================================================================
// STATES: Loading / Error / No-Geofence / Missing-Snapshot
// =============================================================================

function MapSkeleton() {
  return (
    <div className="flex h-full w-full animate-pulse items-center justify-center rounded-xl bg-slate-100">
      <div className="space-y-2 text-center">
        <div className="mx-auto h-10 w-10 rounded-full bg-slate-200" />
        <div className="h-3 w-24 rounded bg-slate-200" />
      </div>
    </div>
  );
}

function NoGeofenceBanner() {
  return (
    <div data-testid="no-geofence-banner" className="flex h-full w-full items-center justify-center rounded-xl border border-amber-200 bg-amber-50 p-6">
      <div className="text-center">
        <svg className="mx-auto mb-2 h-8 w-8 text-amber-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-sm font-medium text-amber-700">Dự án chưa thiết lập vùng địa lý</p>
        <p className="mt-1 text-xs text-amber-600">Tổ chức cần vẽ geofence trong trang quản lý dự án.</p>
      </div>
    </div>
  );
}

/** Banner cho record cũ thiếu snapshot — không vẽ current geofence để tránh sai lệch lịch sử. */
function MissingSnapshotBanner() {
  return (
    <div data-testid="missing-snapshot-banner" className="flex h-full w-full items-center justify-center rounded-xl border border-amber-200 bg-amber-50 p-6">
      <div className="text-center">
        <svg className="mx-auto mb-2 h-8 w-8 text-amber-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-sm font-medium text-amber-700">Không có dữ liệu geofence lịch sử</p>
        <p className="mt-1 text-xs text-amber-600">Bản ghi xác minh này được tạo trước khi hệ thống lưu snapshot. Không hiển thị geofence hiện tại để tránh giải thích sai verdict cũ.</p>
      </div>
    </div>
  );
}

function MapErrorBanner({ message }: { message: string }) {
  return (
    <div data-testid="map-error-banner" className="flex h-full w-full items-center justify-center rounded-xl border border-red-200 bg-red-50 p-6">
      <div className="text-center">
        <svg className="mx-auto mb-2 h-8 w-8 text-red-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-sm font-medium text-red-700">Không thể tải dữ liệu bản đồ</p>
        <p className="mt-1 text-xs text-red-500">{message}</p>
      </div>
    </div>
  );
}

// =============================================================================
// Legend — chú thích màu marker (chỉ hiện status có mặt)
// =============================================================================

function MapLegend({ statuses }: { statuses: GeofenceMarkerStatus[] }) {
  if (statuses.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 z-[500] rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm">
      <p className="mb-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Chú thích</p>
      <div className="space-y-1">
        {statuses.map((status) => {
          const { fillColor, label } = MARKER_COLORS[status];
          return (
            <div key={status} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border border-white shadow-sm" style={{ backgroundColor: fillColor }} />
              <span className="text-xs text-slate-600">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// NoGpsOverlay — card vàng "?" cho marker không có tọa độ (Q3)
// =============================================================================

function NoGpsOverlay({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div
      data-testid="no-gps-overlay"
      className="absolute left-3 top-3 z-[500] flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 shadow-sm backdrop-blur-sm"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400 text-sm font-bold text-white">?</span>
      <div>
        <p className="text-xs font-semibold text-amber-700">Thiếu GPS trong ảnh</p>
        <p className="text-[11px] text-amber-600">
          {count} ảnh không có tọa độ EXIF — không thể định vị trên bản đồ.
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// EvidencePopup — nội dung popup cho một marker có tọa độ
// =============================================================================

function EvidencePopup({ marker }: { marker: GeofenceMarker }) {
  const colors = MARKER_COLORS[marker.status];
  const thumbnailUrl = marker.evidenceThumbnailUrl ?? '';

  return (
    <div className="text-xs">
      <p className="font-semibold" style={{ color: colors.color }}>
        {marker.verificationMessage ?? colors.label}
      </p>

      {/* Thumbnail chỉ render từ URL đã kiểm soát/proxy bởi caller để tránh reviewer tự gọi IPFS gateway lạ. */}
      {thumbnailUrl && (
        /* eslint-disable-next-line @next/next/no-img-element -- Ảnh nằm trong Leaflet popup và chỉ dùng URL đã được caller/proxy kiểm soát. */
        <img
          src={thumbnailUrl}
          alt="Ảnh minh chứng"
          className="mt-1.5 h-24 w-full rounded object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      )}

      {marker.coordinate && (
        <p className="mt-1.5 text-slate-500">{formatCoordinate(marker.coordinate)}</p>
      )}

      {typeof marker.distanceMeters === 'number' && (
        <p className="mt-0.5 text-slate-500">Khoảng cách: {marker.distanceMeters.toFixed(1)} m</p>
      )}

      {marker.capturedAt && (
        <p className="mt-0.5 text-slate-500">Thời điểm: {formatTimestamp(marker.capturedAt)}</p>
      )}

      {marker.evidenceCid && (
        <p className="mt-0.5 max-w-[200px] truncate font-mono text-[11px] text-slate-400">
          CID: {marker.evidenceCid}
        </p>
      )}
    </div>
  );
}

// =============================================================================
// GeofenceMap — main component
// =============================================================================

export default function GeofenceMap({ projectId, snapshot, markers = EMPTY_GEOFENCE_MARKERS, className }: GeofenceMapProps) {
  // Khi caller truyền snapshot (kể cả null) → dùng dữ liệu lịch sử, tắt fetch geofence hiện tại.
  const snapshotProvided = snapshot !== undefined;
  const { data: fetchedGeofence, isLoading, error } = useGeofence(snapshotProvided ? undefined : projectId);

  const containerClass = `relative h-64 w-full overflow-hidden rounded-xl ${className ?? ''}`;
  const geofence: GeofenceSnapshotView | null = snapshotProvided
    ? (snapshot ?? null)
    : (fetchedGeofence ?? null);

  const polygonPositions = useMemo(
    () => geofence?.polygon.map((p) => [p.lat, p.lng] as [number, number]) ?? [],
    [geofence?.polygon]
  );
  const centroidLatLng = useMemo<[number, number]>(
    () => geofence ? [geofence.centroid.lat, geofence.centroid.lng] : [0, 0],
    [geofence]
  );

  // Marker có tọa độ thật (VALID/INVALID) vs marker NO_GPS (không định vị được).
  const locatedMarkers = useMemo(
    () => markers.filter((m) => m.coordinate !== null),
    [markers]
  );
  const noGpsMarkers = useMemo(
    () => markers.filter((m) => m.coordinate === null),
    [markers]
  );

  const boundsPoints = useMemo<LatLng[]>(
    () => [
      ...(geofence?.polygon ?? []),
      ...locatedMarkers.map((m) => m.coordinate as LatLng),
    ],
    [geofence?.polygon, locatedMarkers]
  );
  const boundsPointsKey = useMemo(
    () => boundsPoints.map((p) => `${p.lat},${p.lng}`).join('|'),
    [boundsPoints]
  );

  const presentStatuses = useMemo(
    () => (['VALID', 'INVALID', 'NO_GPS'] as GeofenceMarkerStatus[]).filter(
      (status) => markers.some((m) => m.status === status)
    ),
    [markers]
  );

  // Record cũ thiếu snapshot → cảnh báo, không vẽ current geofence (tránh sai lệch verdict lịch sử)
  if (snapshotProvided && snapshot === null) {
    return <div className={containerClass}><MissingSnapshotBanner /></div>;
  }

  // Fetch states (chỉ áp dụng khi không truyền snapshot)
  if (!snapshotProvided) {
    if (isLoading) {
      return <div className={containerClass}><MapSkeleton /></div>;
    }
    if (error) {
      // 404 = dự án chưa có geofence — không phải lỗi hệ thống
      if (error.statusCode === 404) {
        return <div className={containerClass}><NoGeofenceBanner /></div>;
      }
      return (
        <div className={containerClass}>
          <MapErrorBanner message={error.message ?? 'Vui lòng thử lại.'} />
        </div>
      );
    }
  }

  if (!geofence) return null;

  return (
    <div className={containerClass}>
      <MapContainer
        center={centroidLatLng}
        zoom={14}
        scrollWheelZoom={false}
        className="h-full w-full"
        // Giữ dragging + touchZoom mặc định để pan/pinch trên mobile hoạt động
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000'}/api/tiles/{z}/{x}/{y}.png`}
        />

        {/* Fit bounds về polygon + marker có tọa độ sau khi map mount */}
        <BoundsFitter points={boundsPoints} pointsKey={boundsPointsKey} />

        {/* Polygon — ranh giới verdict của Oracle; circle chỉ là reference Haversine. */}
        {polygonPositions.length >= 3 && (
          <Polygon
            positions={polygonPositions}
            pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 2 }}
          />
        )}

        {/* Circle — bán kính snapshot thực sự dùng để verify Haversine */}
        <Circle
          center={centroidLatLng}
          radius={geofence.radiusMeters}
          pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.04, weight: 1.5, dashArray: '6 4' }}
        />

        {/* Centroid — điểm tham chiếu Haversine của snapshot */}
        <CircleMarker
          center={centroidLatLng}
          radius={7}
          pathOptions={{ color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            <div className="text-xs">
              <p className="font-semibold">Trung tâm dự án</p>
              <p className="text-slate-500">{formatCoordinate(geofence.centroid)}</p>
              <p className="mt-1 text-slate-500">Bán kính: {geofence.radiusMeters} m</p>
            </div>
          </Popup>
        </CircleMarker>

        {/* Evidence markers — chỉ vẽ marker có tọa độ thật; NO_GPS dùng overlay riêng */}
        {locatedMarkers.map((marker) => {
          const colors = MARKER_COLORS[marker.status];
          const coordinate = marker.coordinate as LatLng;
          return (
            <CircleMarker
              key={marker.id}
              center={[coordinate.lat, coordinate.lng]}
              radius={8}
              pathOptions={{
                color: colors.color,
                fillColor: colors.fillColor,
                fillOpacity: 0.85,
                weight: 2
              }}
            >
              <Popup>
                <EvidencePopup marker={marker} />
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Overlay NO_GPS — card vàng "?" thay cho pin địa lý giả (Q3) */}
      <NoGpsOverlay count={noGpsMarkers.length} />

      {/* Legend overlay — nằm trên map (z-[500] cao hơn Leaflet default 400) */}
      <MapLegend statuses={presentStatuses} />
    </div>
  );
}
