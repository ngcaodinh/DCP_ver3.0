'use client';

// =============================================================================
// GeofenceMap — B3: Bản đồ Leaflet hiển thị vùng geofence + GPS markers.
// Component này KHÔNG dùng trực tiếp — import qua GeofenceMapLazy để tránh SSR lỗi.
// Leaflet là DOM-only library, cần next/dynamic ssr:false ở wrapper.
// =============================================================================

import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Polygon, Circle, CircleMarker, Marker, Popup, useMap } from 'react-leaflet';
import { useGeofence } from '@/app/hooks/useGeofence';

// Sửa lỗi icon Leaflet bị broken khi bundle qua webpack/Next.js
// (Leaflet tìm icon theo path tương đối, webpack đổi path → 404)
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// =============================================================================
// TYPES
// =============================================================================

export type GeofenceMarkerStatus = 'VALID' | 'INVALID' | 'NO_GPS';

export type GeofenceMarker = {
  lat: number;
  lng: number;
  /** Màu marker: xanh=VALID, đỏ=INVALID, vàng=NO_GPS */
  status: GeofenceMarkerStatus;
  /** Nhãn hiển thị trong Popup (CID, tên ảnh, v.v.) */
  label?: string;
  // TODO: thêm distanceMeters?: number và timestamp?: string vào Popup khi refactor
  // — data đã có trong PendingOverrideItem.distanceMeters và .createdAt, cần truyền qua buildMarkersFromItem
  // TODO: thêm thumbnailUrl?: string (construct từ NEXT_PUBLIC_IPFS_GATEWAY_URL + evidenceCid)
  // — giúp admin xem ảnh minh chứng trực tiếp trong Popup không cần scroll
};

export type GeofenceMapProps = {
  projectId: string;
  /** Danh sách GPS marker từ ảnh minh chứng. Bỏ qua nếu không có. */
  markers?: GeofenceMarker[];
  className?: string;
};

// =============================================================================
// HELPERS
// =============================================================================

const MARKER_COLORS: Record<GeofenceMarkerStatus, { color: string; fillColor: string; label: string }> = {
  VALID:   { color: '#16a34a', fillColor: '#22c55e', label: 'Trong vùng' },
  INVALID: { color: '#dc2626', fillColor: '#ef4444', label: 'Ngoài vùng' },
  NO_GPS:  { color: '#d97706', fillColor: '#f59e0b', label: 'Không có GPS' },
};

/** Fit map bounds về polygon geofence sau khi data load — cần useMap nên phải là child component */
function BoundsFitter({ polygon }: { polygon: { lat: number; lng: number }[] }) {
  const map = useMap();
  useEffect(() => {
    if (polygon.length >= 3) {
      const latLngs = polygon.map((p) => L.latLng(p.lat, p.lng));
      map.fitBounds(L.latLngBounds(latLngs), { padding: [24, 24], maxZoom: 16 });
    }
  }, [map, polygon]);
  return null;
}

// =============================================================================
// STATES: Loading / Error / No-Geofence
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
// Legend — chú thích màu marker
// =============================================================================

function MapLegend({ hasMarkers }: { hasMarkers: boolean }) {
  if (!hasMarkers) return null;
  return (
    <div className="absolute bottom-3 right-3 z-[500] rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm">
      <p className="mb-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Chú thích</p>
      <div className="space-y-1">
        {(Object.entries(MARKER_COLORS) as [GeofenceMarkerStatus, typeof MARKER_COLORS[GeofenceMarkerStatus]][]).map(
          ([status, { fillColor, label }]) => (
            <div key={status} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border border-white shadow-sm" style={{ backgroundColor: fillColor }} />
              <span className="text-xs text-slate-600">{label}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// =============================================================================
// GeofenceMap — main component
// =============================================================================

export default function GeofenceMap({ projectId, markers = [], className }: GeofenceMapProps) {
  const { data: geofence, isLoading, error } = useGeofence(projectId);

  const containerClass = `relative h-64 w-full overflow-hidden rounded-xl ${className ?? ''}`;

  if (isLoading) {
    return <div className={containerClass}><MapSkeleton /></div>;
  }

  // 404 = dự án chưa có geofence — không phải lỗi hệ thống
  if (error) {
    if (error.statusCode === 404) {
      return <div className={containerClass}><NoGeofenceBanner /></div>;
    }
    return (
      <div className={containerClass}>
        <MapErrorBanner message={error.message ?? 'Vui lòng thử lại.'} />
      </div>
    );
  }

  if (!geofence) return null;

  const polygonPositions = geofence.polygon.map((p) => [p.lat, p.lng] as [number, number]);
  const centroidLatLng: [number, number] = [geofence.centroid.lat, geofence.centroid.lng];

  return (
    <div className={containerClass}>
      <MapContainer
        center={centroidLatLng}
        zoom={14}
        scrollWheelZoom={false}
        className="h-full w-full"
        // zoomControl mặc định top-left — ổn với layout drawer
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000'}/api/tiles/{z}/{x}/{y}.png`}
        />

        {/* Fit bounds về polygon sau khi map mount */}
        <BoundsFitter polygon={geofence.polygon} />

        {/* Polygon — vùng ranh giới (chỉ dùng để hiển thị, verify dùng circle radius) */}
        {polygonPositions.length >= 3 && (
          <Polygon
            positions={polygonPositions}
            pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 2 }}
          />
        )}

        {/* Circle — bán kính Haversine thực sự dùng để verify */}
        <Circle
          center={centroidLatLng}
          radius={geofence.radiusMeters}
          pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.04, weight: 1.5, dashArray: '6 4' }}
        />

        {/* Centroid — điểm tham chiếu Haversine của dự án */}
        <CircleMarker
          center={centroidLatLng}
          radius={7}
          pathOptions={{ color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            <div className="text-xs">
              <p className="font-semibold">Trung tâm dự án</p>
              <p className="text-slate-500">{`${geofence.centroid.lat.toFixed(6)}, ${geofence.centroid.lng.toFixed(6)}`}</p>
              <p className="mt-1 text-slate-500">Bán kính: {geofence.radiusMeters} m</p>
            </div>
          </Popup>
        </CircleMarker>

        {/* GPS markers từ ảnh minh chứng */}
        {markers.map((m, idx) => {
          const colors = MARKER_COLORS[m.status];
          return (
            <CircleMarker
              key={idx}
              center={[m.lat, m.lng]}
              radius={8}
              pathOptions={{
                color: colors.color,
                fillColor: colors.fillColor,
                fillOpacity: 0.85,
                weight: 2
              }}
            >
              <Popup>
                <div className="text-xs">
                  <p className="font-semibold" style={{ color: colors.color }}>{colors.label}</p>
                  <p className="text-slate-500">{`${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}`}</p>
                  {m.label && <p className="mt-1 truncate text-slate-400 max-w-[180px]">{m.label}</p>}
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Legend overlay — nằm trên map (z-[500] cao hơn Leaflet default 400) */}
      <MapLegend hasMarkers={markers.length > 0} />
    </div>
  );
}
