'use client';

// =============================================================================
// GpsMarkerOnlyMapInner — B4: Component Leaflet thực tế hiển thị GPS markers.
// KHÔNG import trực tiếp — dùng qua GpsMarkerOnlyMap (wrapper dynamic ssr:false).
// Tách file riêng (giống GeofenceMap/GeofenceMapLazy) để import('./...') thật sự
// code-split leaflet/react-leaflet ra chunk riêng, tránh eager-evaluate lúc SSR.
// =============================================================================

import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import type { GpsCoordinate } from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

// Sửa lỗi icon Leaflet bị broken khi bundle qua webpack/Next.js
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export type GpsMarkerOnlyMapProps = {
  /** Tọa độ GPS lấy từ EXIF ảnh — null khi ảnh không có GPS. */
  gpsFromImage: GpsCoordinate | null;
  /** Tọa độ GPS trung tâm dự án — luôn có. */
  gpsFromProject: GpsCoordinate;
  className?: string;
};

/**
 * Sub-component fit map bounds về các điểm GPS sau khi mount.
 * Định nghĩa ở module scope (không lồng trong component render) để tránh
 * React coi là component reference mới mỗi lần re-render, gây unmount/remount
 * và chạy lại useEffect không cần thiết. Cần là child của MapContainer để dùng useMap.
 */
function BoundsAutoFitter({ points }: { points: GpsCoordinate[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0]!.lat, points[0]!.lng], 15);
      return;
    }
    // Fit bounds bao gồm cả 2 điểm với padding
    const latLngs = points.map((p) => L.latLng(p.lat, p.lng));
    map.fitBounds(L.latLngBounds(latLngs), { padding: [32, 32], maxZoom: 16 });
  }, [map, points]);
  return null;
}

/**
 * Component nội bộ dùng Leaflet, được wrap bằng next/dynamic ssr:false qua GpsMarkerOnlyMap.
 * Không được import trực tiếp — dùng qua GpsMarkerOnlyMap.
 */
export default function GpsMarkerOnlyMapInner({ gpsFromImage, gpsFromProject, className }: GpsMarkerOnlyMapProps) {
  const containerClass = `relative h-48 w-full overflow-hidden rounded-xl ${className ?? ''}`;

  // Điểm trung tâm ban đầu là GPS dự án (luôn có)
  const centerLatLng: [number, number] = [gpsFromProject.lat, gpsFromProject.lng];

  // Danh sách điểm cần fit bounds: luôn có GPS dự án, thêm GPS ảnh nếu có
  const boundsPoints: GpsCoordinate[] = [gpsFromProject];
  if (gpsFromImage) boundsPoints.push(gpsFromImage);

  return (
    <div className={containerClass}>
      <MapContainer
        center={centerLatLng}
        zoom={14}
        scrollWheelZoom={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000'}/api/tiles/{z}/{x}/{y}.png`}
        />

        {/* Fit bounds tự động về các điểm GPS */}
        <BoundsAutoFitter points={boundsPoints} />

        {/* Marker GPS dự án (xanh dương — điểm tham chiếu) */}
        <CircleMarker
          center={centerLatLng}
          radius={8}
          pathOptions={{ color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            <div className="text-xs">
              <p className="font-semibold text-blue-700">Trung tâm dự án</p>
              <p className="text-slate-500">{`${gpsFromProject.lat.toFixed(6)}, ${gpsFromProject.lng.toFixed(6)}`}</p>
            </div>
          </Popup>
        </CircleMarker>

        {/* Marker GPS ảnh (đỏ — điểm nghi vấn) — chỉ hiển thị khi có EXIF GPS */}
        {gpsFromImage && (
          <CircleMarker
            center={[gpsFromImage.lat, gpsFromImage.lng]}
            radius={8}
            pathOptions={{ color: '#dc2626', fillColor: '#ef4444', fillOpacity: 0.85, weight: 2 }}
          >
            <Popup>
              <div className="text-xs">
                <p className="font-semibold text-red-700">GPS từ ảnh (EXIF)</p>
                <p className="text-slate-500">{`${gpsFromImage.lat.toFixed(6)}, ${gpsFromImage.lng.toFixed(6)}`}</p>
              </div>
            </Popup>
          </CircleMarker>
        )}
      </MapContainer>

      {/* Legend nhỏ gọn — chỉ 2 loại marker */}
      <div className="absolute bottom-2 right-2 z-[500] rounded-md border border-slate-200 bg-white/90 px-2 py-1.5 shadow-sm backdrop-blur-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            <span className="text-[10px] text-slate-600">Trung tâm dự án</span>
          </div>
          {gpsFromImage && (
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              <span className="text-[10px] text-slate-600">GPS từ ảnh</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
