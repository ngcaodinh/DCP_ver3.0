import type { ReactElement } from 'react';

type DeviationLevel = 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';

/** Hiển thị mức lệch do backend tính, không lặp lại logic ngưỡng GPS ở frontend. */
export function EvidenceDeviationBadge(props: { deviationLevel: DeviationLevel; distanceMeters: number | null; accuracyMeters: number }): ReactElement {
  const metadata: Record<DeviationLevel, { label: string; className: string }> = {
    INSIDE: { label: 'Trong vùng dự án', className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    WITHIN_ACCURACY: { label: 'Trong phạm vi sai số thiết bị', className: 'border-amber-200 bg-amber-50 text-amber-900' },
    DEVIATED: { label: 'Ảnh chụp lệch vùng dự án', className: 'border-orange-200 bg-orange-50 text-orange-900' },
    CRITICAL: { label: 'Lệch vị trí nghiêm trọng', className: 'border-rose-200 bg-rose-50 text-rose-900' },
    NO_GEOFENCE: { label: 'Chưa thiết lập vùng địa lý', className: 'border-slate-200 bg-slate-50 text-slate-700' }
  };
  const current = metadata[props.deviationLevel];
  const distanceText = props.distanceMeters === null ? '' : ' · ' + Math.round(props.distanceMeters) + ' m';
  const accuracyText = props.deviationLevel === 'WITHIN_ACCURACY' ? ' (±' + Math.round(props.accuracyMeters) + ' m)' : '';
  return <span className={'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ' + current.className}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{current.label}{distanceText}{accuracyText}</span>;
}
