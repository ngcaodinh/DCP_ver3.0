/** Bản sao UX của policy BE/src/constants/evidenceCapturePolicy.ts; BE vẫn là nguồn sự thật. */
export const EVIDENCE_CAPTURE_POLICY = { maxPhotos: 5, maxAccuracyMeters: 100, lowAccuracyDelayMs: 45_000, maxImageBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxImageDimension: 1600 } as const;
