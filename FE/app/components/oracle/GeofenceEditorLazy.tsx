'use client';

// =============================================================================
// GeofenceEditorLazy — B5: Wrapper next/dynamic cho GeofenceEditor.
// Leaflet yêu cầu DOM nên phải disable SSR. Mọi nơi dùng editor import từ đây,
// không import GeofenceEditor trực tiếp.
// =============================================================================

import dynamic from 'next/dynamic';
import type { GeofenceEditorProps } from './GeofenceEditor';

/** Skeleton hiển thị khi JS bundle đang tải */
function EditorLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-96 w-full rounded-xl bg-slate-100" />
      <div className="h-10 w-full rounded-lg bg-slate-100" />
      <div className="h-10 w-full rounded-xl bg-slate-100" />
    </div>
  );
}

const GeofenceEditorDynamic = dynamic(() => import('./GeofenceEditor'), {
  ssr: false,
  loading: EditorLoadingSkeleton,
});

export function GeofenceEditorLazy(props: GeofenceEditorProps) {
  return <GeofenceEditorDynamic {...props} />;
}
