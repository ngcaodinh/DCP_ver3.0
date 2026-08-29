import { type ReactElement, useState } from 'react';
import { buildIpfsGatewayUrl, buildIpfsGatewayUrlList } from '@/app/utils/ipfs';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';

export interface EvidencePhoto {
  cid: string;
  capturedAt: string;
  gps: { latitude: number; longitude: number };
  accuracyMeters: number;
  distanceMeters?: number | null;
  deviationLevel?: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';
  isLowAccuracyOverride: boolean;
  lowAccuracyReason: string | null;
}

/** Rút gọn CID dài khi hiển thị nhưng vẫn giữ phần đầu và cuối để đối chiếu nhanh. */
function formatCompactCid(cid: string): string {
  if (cid.length <= 18) return cid;
  return cid.slice(0, 10) + '...' + cid.slice(-6);
}

/** Hiển thị ảnh camera kèm GPS, có fallback gateway và không render ảnh khi CID không hợp lệ. */
export function ChallengeEvidenceGallery({ photos }: { photos: EvidencePhoto[] }): ReactElement {
  if (!photos.length) return <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">Khiếu nại này không kèm ảnh camera.</p>;
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
  const image = <img src={url} loading="lazy" alt="Ảnh minh chứng hiện trường" onError={() => setIndex(current => current + 1)} className="aspect-video w-full rounded-xl object-cover" />;
  return <figure className={'min-w-0 rounded-2xl border p-2.5 shadow-sm sm:p-3 ' + (photo.isLowAccuracyOverride ? 'border-amber-300 bg-amber-50' : 'border-teal-100 bg-teal-50/30')}>
    {url ? <>{image}<a href={primaryUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full break-all rounded-lg bg-white px-2.5 py-1.5 text-sm text-teal-800 underline decoration-teal-300 underline-offset-2"><span className="font-semibold">Mã CID:</span>&nbsp;{formatCompactCid(photo.cid)}</a></> : <div className="aspect-video rounded-xl bg-slate-100 p-3 text-sm text-slate-500">Ảnh không tải được</div>}
    {photo.deviationLevel ? <div className="mt-3"><EvidenceDeviationBadge deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters ?? null} accuracyMeters={photo.accuracyMeters} /></div> : null}
    <figcaption className="mt-3 break-words text-xs leading-5 text-slate-600">Vị trí: {photo.gps.latitude.toFixed(4)}, {photo.gps.longitude.toFixed(4)} · sai số ±{Math.round(photo.accuracyMeters)} m<br />Thời gian chụp: {new Date(photo.capturedAt).toLocaleString('vi-VN')}{photo.isLowAccuracyOverride && <><br /><span className="font-medium text-amber-800">Chụp qua van thoát</span>: {photo.lowAccuracyReason}</>}</figcaption>
  </figure>;
}
