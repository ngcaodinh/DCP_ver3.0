'use client';

// =============================================================================
// GeofenceMapLazy — B3: Wrapper next/dynamic cho GeofenceMap.
// Leaflet yêu cầu DOM nên phải disable SSR. Mọi nơi dùng map import từ đây,
// không import GeofenceMap trực tiếp.
// =============================================================================

import dynamic from 'next/dynamic';
import type { GeofenceMapProps } from './GeofenceMap';

/** Skeleton hiển thị trong khoảng dynamic import đang tải JS bundle */
function MapLoadingSkeleton() {
  return (
    <div className="flex h-64 w-full animate-pulse items-center justify-center rounded-xl bg-slate-100">
      <div className="space-y-2 text-center">
        <div className="mx-auto h-10 w-10 rounded-full bg-slate-200" />
        <div className="h-3 w-24 rounded bg-slate-200" />
      </div>
    </div>
  );
}

const GeofenceMapDynamic = dynamic(() => import('./GeofenceMap'), {
  ssr: false,
  loading: MapLoadingSkeleton,
});

export function GeofenceMapLazy(props: GeofenceMapProps) {
  return <GeofenceMapDynamic {...props} />;
}
