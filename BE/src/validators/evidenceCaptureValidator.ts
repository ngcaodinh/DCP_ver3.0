import { z } from 'zod';
import { EVIDENCE_CAPTURE_POLICY } from '../constants/evidenceCapturePolicy';

/** Kiểm tra metadata ảnh camera trước khi chuyển vào nghiệp vụ evidence. */
export const capturedEvidencePhotoSchema = z.object({
  fileName: z.string().trim().regex(/^capture-\d+\.jpg$/).max(255),
  mimeType: z.literal('image/jpeg'),
  contentBase64: z.string().trim().min(1),
  gps: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  accuracyMeters: z.number().positive().max(EVIDENCE_CAPTURE_POLICY.maxOverrideAccuracyMeters),
  capturedAtClient: z.string().datetime(),
  geolocationTimestamp: z.string().datetime(),
  lowAccuracyOverride: z.boolean(),
  overrideUnlockedAfterMs: z.number().int().nonnegative().nullable(),
  lowAccuracyReason: z.string().trim().min(20).max(300).nullable()
}).superRefine((photo, context) => {
  if (photo.lowAccuracyOverride && !photo.lowAccuracyReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lowAccuracyReason'], message: 'Cần nêu lý do khi chụp qua van thoát.' });
  }
  if (photo.lowAccuracyOverride && (photo.overrideUnlockedAfterMs === null || photo.overrideUnlockedAfterMs < EVIDENCE_CAPTURE_POLICY.overrideUnlockDelayMs)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['overrideUnlockedAfterMs'], message: 'Van thoát độ chính xác chỉ mở sau thời gian chờ bắt buộc.' });
  }
  if (!photo.lowAccuracyOverride && photo.lowAccuracyReason !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lowAccuracyReason'], message: 'Lý do van thoát phải là null khi không dùng van thoát.' });
  }
  if (!photo.lowAccuracyOverride && photo.overrideUnlockedAfterMs !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['overrideUnlockedAfterMs'], message: 'Thời gian mở van thoát phải là null khi không dùng van thoát.' });
  }
  if (!photo.lowAccuracyOverride && photo.accuracyMeters > EVIDENCE_CAPTURE_POLICY.maxAccuracyMeters) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['accuracyMeters'], message: 'Độ chính xác chưa đạt ngưỡng.' });
  }
});
