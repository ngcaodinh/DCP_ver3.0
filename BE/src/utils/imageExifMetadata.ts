import { create as createExifParser } from 'exif-parser';

export interface ImageExifMetadata {
  gps: { lat: number; lng: number } | null;
  capturedAt: Date | null;
}

/** Đọc EXIF theo hướng best-effort; ảnh thiếu metadata vẫn là dữ liệu hợp lệ. */
export function readImageExifMetadata(buffer: Buffer): ImageExifMetadata {
  try {
    const tags = createExifParser(buffer).parse().tags;
    const lat = Number(tags.GPSLatitude);
    const lng = Number(tags.GPSLongitude);
    const capturedTimestamp = Number(tags.DateTimeOriginal || tags.CreateDate);
    return {
      gps: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
      capturedAt: Number.isFinite(capturedTimestamp) && capturedTimestamp > 0 ? new Date(capturedTimestamp * 1000) : null
    };
  } catch {
    return { gps: null, capturedAt: null };
  }
}
