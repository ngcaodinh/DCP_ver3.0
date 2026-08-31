import { type ReactElement, useState } from 'react';
import { buildIpfsGatewayUrl, buildIpfsGatewayUrlList } from '@/app/utils/ipfs';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';

export interface EvidencePhoto {
  cid: string;
  capturedAt: string | null;
  gps: { latitude: number; longitude: number } | null;
  accuracyMeters: number;
  distanceMeters?: number | null;
  distanceToProjectCenterMeters?: number | null;
  deviationLevel?: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
  sourceLabel?: string;
}

/** Rút gọn CID dài khi hiển thị nhưng vẫn giữ phần đầu và cuối để đối chiếu nhanh. */
function formatCompactCid(cid: string): string {
  if (cid.length <= 18) return cid;
  return cid.slice(0, 10) + '...' + cid.slice(-6);
}

/** Hiển thị ảnh camera kèm GPS, có fallback gateway và thông điệp rỗng phù hợp theo ngữ cảnh. */
export function ChallengeEvidenceGallery({ photos, emptyMessage = 'Khiếu nại này không kèm ảnh camera.' }: { photos: EvidencePhoto[]; emptyMessage?: string }): ReactElement {
  if (!photos.length) return <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">{emptyMessage}</p>;
  return <div className="grid min-w-0 gap-3 sm:grid-cols-2">{photos.map(photo => <EvidenceImage key={photo.cid} photo={photo} />)}</div>;
}

/** Hiển thị một thumbnail với gateway dự phòng theo thứ tự allowlist. */
function EvidenceImage({ photo }: { photo: EvidencePhoto }): ReactElement {
  const urls = buildIpfsGatewayUrlList(photo.cid);
  const [index, setIndex] = useState(0);
  const primaryUrl = buildIpfsGatewayUrl(photo.cid);
  const url = urls[index] || '';
  // IPFS dùng gateway dự phòng qua onError nên không thể dùng Next Image với một URL cố định.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={url} loading="lazy" alt={photo.sourceLabel || 'Ảnh minh chứng hiện trường'} onError={() => setIndex(current => current + 1)} className="aspect-video w-full rounded-xl object-cover" />;
  return <figure className={'min-w-0 rounded-2xl border p-2.5 shadow-sm sm:p-3 ' + (photo.isLowAccuracyOverride ? 'border-amber-300 bg-amber-50' : 'border-teal-100 bg-teal-50/30')}>
    {url ? <>{image}<a href={primaryUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full break-all rounded-lg bg-white px-2.5 py-1.5 text-sm text-teal-800 underline decoration-teal-300 underline-offset-2"><span className="font-semibold">Mã CID:</span>&nbsp;{formatCompactCid(photo.cid)}</a></> : <div className="aspect-video rounded-xl bg-slate-100 p-3 text-sm text-slate-500">Ảnh không tải được<p className="mt-2 break-all font-mono text-xs text-slate-600">Mã CID: {formatCompactCid(photo.cid)}</p></div>}
    {photo.deviationLevel ? <div className="mt-3"><EvidenceDeviationBadge deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters ?? null} accuracyMeters={photo.accuracyMeters} /></div> : null}
    <figcaption className="mt-3 space-y-3 break-words text-sm leading-5 text-slate-700">{photo.sourceLabel ? <p className="font-bold text-slate-900">Nguồn ảnh: {photo.sourceLabel}</p> : null}<dl className="grid gap-2 rounded-xl border border-slate-200 bg-white/80 p-3 sm:grid-cols-2"><div><dt className="text-xs font-medium text-slate-500">Vị trí chụp</dt><dd className="mt-1 font-mono text-sm font-bold text-slate-900">{photo.gps ? `${photo.gps.latitude.toFixed(4)}, ${photo.gps.longitude.toFixed(4)}` : 'Không có GPS'}</dd></div><div><dt className="text-xs font-medium text-slate-500">Sai số GPS</dt><dd className="mt-1 text-sm font-bold text-slate-900">±{Math.round(photo.accuracyMeters)} m</dd></div>{typeof photo.distanceToProjectCenterMeters === 'number' ? <div className="sm:col-span-2"><dt className="text-xs font-medium text-slate-500">Khoảng cách đến tâm vị trí dự án</dt><dd className="mt-1 text-base font-bold text-[#0A5C50]">{Math.round(photo.distanceToProjectCenterMeters)} m</dd></div> : null}</dl><p>Thời gian chụp: <span className="font-semibold text-slate-900">{photo.capturedAt ? new Date(photo.capturedAt).toLocaleString('vi-VN') : 'Không xác định'}</span>{photo.isLowAccuracyOverride ? <><br /><span className="font-semibold text-amber-800">Chụp qua van thoát</span>: {photo.lowAccuracyReason}</> : null}</p></figcaption>
  </figure>;
}
