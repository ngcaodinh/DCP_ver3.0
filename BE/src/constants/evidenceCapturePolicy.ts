/** Đọc số dương từ môi trường, dùng giá trị mặc định khi cấu hình không hợp lệ. */
function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Các ngưỡng bảo mật dùng chung khi tiếp nhận ảnh chụp trực tiếp từ camera. */
export const EVIDENCE_CAPTURE_POLICY = {
  maxPhotos: 5,
  minPhotoBytes: 1024,
  maxPhotoBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxAccuracyMeters: readPositiveNumber('EVIDENCE_GPS_ACCURACY_THRESHOLD_METERS', 100),
  maxOverrideAccuracyMeters: 2_000,
  overrideUnlockDelayMs: 45 * 1000,
  maxClockSkewMs: 5 * 60 * 1000,
  maxPhotoAgeMs: 60 * 60 * 1000,
  maxFuturePhotoAgeMs: 2 * 60 * 1000,
  maxGeolocationTimestampDeltaMs: 2 * 60 * 1000
} as const;
