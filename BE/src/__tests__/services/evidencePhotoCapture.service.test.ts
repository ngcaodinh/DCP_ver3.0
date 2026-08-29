import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindByHash, mockUnpin, mockUpload } = vi.hoisted(() => ({ mockFindByHash: vi.fn(), mockUnpin: vi.fn(), mockUpload: vi.fn() }));
vi.mock('../../repositories/evidencePhotoRegistryRepository', () => ({ findEvidencePhotoRegistryBySha256FromRepository: mockFindByHash }));
vi.mock('../../services/projectService', () => ({ unpinProjectEvidenceCidFromPinataWithRetry: mockUnpin, uploadProjectEvidenceFileToPinataWithRetry: mockUpload }));

import { cleanupCapturedEvidencePhotos, processCapturedEvidencePhotos } from '../../services/evidencePhotoCapture.service';

const submittedAt = new Date('2026-08-20T10:00:00.000Z');
const validJpegBase64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(1020)]).toString('base64');
const validJpegBase64Variant = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(1019), Buffer.from([1])]).toString('base64');
const photo = { fileName: 'capture-1.jpg', mimeType: 'image/jpeg' as const, contentBase64: validJpegBase64, gps: { latitude: 21, longitude: 105 }, accuracyMeters: 20, capturedAtClient: submittedAt.toISOString(), geolocationTimestamp: submittedAt.toISOString(), lowAccuracyOverride: false, overrideUnlockedAfterMs: null, lowAccuracyReason: null };

describe('processCapturedEvidencePhotos', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFindByHash.mockResolvedValue(null); mockUpload.mockResolvedValue({ cid: 'bafy-photo', fileName: photo.fileName, mimeType: photo.mimeType }); });

  it('pins a valid JPEG and returns normalized metadata without raw image content', async () => {
    const evidencePhotos = await processCapturedEvidencePhotos({ photos: [photo], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt });

    expect(evidencePhotos).toMatchObject([{ cid: 'bafy-photo', accuracyMeters: 20, contentSha256: expect.any(String) }]);
    expect(evidencePhotos[0]).not.toHaveProperty('contentBase64');
  });

  it('rejects duplicate registry evidence before invoking Pinata', async () => {
    mockFindByHash.mockResolvedValue({ contentSha256: 'existing' });
    await expect(processCapturedEvidencePhotos({ photos: [photo], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'DUPLICATE_EVIDENCE_PHOTO', statusCode: 409 });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects expired, malformed and undersized camera evidence', async () => {
    await expect(processCapturedEvidencePhotos({ photos: [{ ...photo, capturedAtClient: new Date(submittedAt.getTime() - 61 * 60 * 1000).toISOString() }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'CAPTURE_EXPIRED' });
    await expect(processCapturedEvidencePhotos({ photos: [{ ...photo, contentBase64: '/9j/2w==' }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    await expect(processCapturedEvidencePhotos({ photos: [{ ...photo, contentBase64: 'data:image/jpeg;base64,/9j/2w==' }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('requires a bounded and time-unlocked low-accuracy override', async () => {
    await expect(processCapturedEvidencePhotos({ photos: [{ ...photo, accuracyMeters: 150, lowAccuracyOverride: true, overrideUnlockedAfterMs: 44_999, lowAccuracyReason: 'Khu vực hiện trường có vật cản làm tín hiệu GPS suy giảm.' }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    await expect(processCapturedEvidencePhotos({ photos: [{ ...photo, accuracyMeters: 2_001, lowAccuracyOverride: true, overrideUnlockedAfterMs: 45_000, lowAccuracyReason: 'Khu vực hiện trường có vật cản làm tín hiệu GPS suy giảm.' }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('cleans up already-uploaded photos when a later Pinata upload fails', async () => {
    mockUpload.mockResolvedValueOnce({ cid: 'bafy-photo-1', fileName: photo.fileName, mimeType: photo.mimeType });
    mockUpload.mockRejectedValueOnce(new Error('Pinata timeout'));
    mockUpload.mockRejectedValueOnce(new Error('Pinata timeout'));

    await expect(processCapturedEvidencePhotos({ photos: [photo, { ...photo, fileName: 'capture-2.jpg', contentBase64: validJpegBase64Variant }], module: 'PROJECT_CHALLENGE', ownerUserId: 'auditor-1', clientSubmittedAt: submittedAt.toISOString(), serverReceivedAt: submittedAt })).rejects.toThrow('Pinata timeout');
    expect(mockUnpin).toHaveBeenCalledWith('bafy-photo-1');
  });

  it('keeps a CID when its content hash is already registered', async () => {
    mockFindByHash.mockResolvedValue({ contentSha256: 'hash-1', cid: 'bafy-photo-1' });

    await cleanupCapturedEvidencePhotos([{ cid: 'bafy-photo-1', contentSha256: 'hash-1' }]);

    expect(mockUnpin).not.toHaveBeenCalled();
  });
});
