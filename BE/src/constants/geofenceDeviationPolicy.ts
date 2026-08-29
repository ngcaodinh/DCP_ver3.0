import { EVIDENCE_CAPTURE_POLICY } from './evidenceCapturePolicy';

/** Ngưỡng lệch nghiêm trọng được thống nhất ở backend; frontend chỉ hiển thị kết quả đã tính. */
export const DEVIATION_CRITICAL_METERS = 500;

export type GeofenceDeviationLevel = 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';

/** Phân loại sai lệch theo độ chính xác thực tế của chính ảnh, không dùng một ngưỡng cứng cho mọi thiết bị. */
export function determineGeofenceDeviationLevel(input: {
  isInsideGeofence: boolean | null;
  distanceMeters: number | null;
  accuracyMeters: number;
  isLowAccuracyOverride?: boolean;
}): GeofenceDeviationLevel {
  if (input.isInsideGeofence === null || input.distanceMeters === null) return 'NO_GEOFENCE';
  if (input.isLowAccuracyOverride) return input.distanceMeters <= DEVIATION_CRITICAL_METERS ? 'DEVIATED' : 'CRITICAL';
  if (input.isInsideGeofence) return 'INSIDE';
  // Không tin accuracy do client gửi vượt quá chốt 100m; ảnh đi qua van thoát luôn phải được Ủy ban nhìn thấy rủi ro.
  const trustedAccuracyMeters = Math.min(input.accuracyMeters, EVIDENCE_CAPTURE_POLICY.maxAccuracyMeters);
  if (input.distanceMeters <= trustedAccuracyMeters) return 'WITHIN_ACCURACY';
  if (input.distanceMeters <= DEVIATION_CRITICAL_METERS) return 'DEVIATED';
  return 'CRITICAL';
}
