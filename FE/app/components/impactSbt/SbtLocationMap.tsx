import type { ReactElement } from 'react';
import { GeofenceMapLazy } from '@/app/components/oracle/GeofenceMapLazy';

interface SbtLocationMapProps {
  gpsCoordinates: string;
  fallbackProjectId: string;
  tokenId: number;
}

interface SbtGpsPoint {
  lat: number;
  lng: number;
}

/** Parse GPS dạng "lat,lng" và chặn tọa độ thiếu, không hữu hạn hoặc ngoài biên địa lý. */
export function parseGpsPoint(gpsCoordinates: string): SbtGpsPoint | null {
  const trimmedCoordinates = gpsCoordinates.trim();
  if (!trimmedCoordinates) return null;

  const parts = trimmedCoordinates.split(',');
  if (parts.length !== 2) return null;

  const lat = Number(parts[0]?.trim());
  const lng = Number(parts[1]?.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

/** Hiển thị mini map public bằng synthetic snapshot để GeofenceMap không gọi API cần auth. */
export default function SbtLocationMap({
  gpsCoordinates,
  fallbackProjectId,
  tokenId
}: SbtLocationMapProps): ReactElement {
  const point = parseGpsPoint(gpsCoordinates);

  return (
    <section data-testid="sbt-location-map" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Vị trí minh chứng SBT #{tokenId}</h2>
      {point ? (
        <div className="mt-4">
          <GeofenceMapLazy
            projectId={fallbackProjectId}
            snapshot={{ polygon: [], centroid: point, radiusMeters: 0 }}
            className="rounded-xl border border-slate-200"
          />
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">Không có dữ liệu vị trí</p>
      )}
    </section>
  );
}
