'use client';

// =============================================================================
// GpsMarkerOnlyMap — B4: Wrapper next/dynamic cho GpsMarkerOnlyMapInner.
// Bản đồ chỉ hiển thị GPS markers, không fetch API — dùng trong OverrideVoteDrawer
// để tránh N concurrent API calls khi có 20 items (thay GeofenceMapLazy vì không
// cần polygon). Leaflet yêu cầu DOM nên phải disable SSR, giống GeofenceMapLazy.
// GeofenceMap (B5) vẫn giữ nguyên cho B5GeofenceEditor (cần polygon + fetch).
// =============================================================================

import dynamic from 'next/dynamic';
import type { GpsMarkerOnlyMapProps } from './GpsMarkerOnlyMapInner';

/** Skeleton hiển thị trong khoảng dynamic import đang tải JS bundle */
function MapLoadingSkeleton() {
  return (
    <div className="flex h-48 w-full animate-pulse items-center justify-center rounded-xl bg-slate-100">
      <div className="h-3 w-20 rounded bg-slate-200" />
    </div>
  );
}

const GpsMarkerOnlyMapDynamic = dynamic(() => import('./GpsMarkerOnlyMapInner'), {
  ssr: false,
  loading: MapLoadingSkeleton,
});

/**
 * Bản đồ chỉ GPS markers — nhận tọa độ trực tiếp từ props, không gọi API.
 * Dùng trong OverrideVoteDrawer thay cho GeofenceMapLazy để tránh 20 concurrent API calls.
 *
 * @param gpsFromImage Tọa độ GPS từ EXIF ảnh (null nếu không có).
 * @param gpsFromProject Tọa độ GPS trung tâm dự án.
 * @param className CSS class cho container.
 */
export function GpsMarkerOnlyMap(props: GpsMarkerOnlyMapProps) {
  return <GpsMarkerOnlyMapDynamic {...props} />;
}

export type { GpsMarkerOnlyMapProps };
