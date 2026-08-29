import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvidencePhotoInput } from '../../services/evidencePhotoCapture.service';

const mocks = vi.hoisted(() => ({
  createVerification: vi.fn(),
  createRegistry: vi.fn(),
  findVerification: vi.fn(),
  findChallenge: vi.fn(),
  findProject: vi.fn(),
  processPhotos: vi.fn(),
  cleanupPhotos: vi.fn(),
  transaction: vi.fn()
}));

vi.mock('../../models/auditorListingVerificationModel', () => ({
  createAuditorListingVerification: mocks.createVerification,
  findListingVerificationByProjectRoundAndUser: mocks.findVerification
}));
vi.mock('../../repositories/evidencePhotoRegistryRepository', () => ({ createEvidencePhotoRegistryRecordsFromRepository: mocks.createRegistry }));
vi.mock('../../repositories/projectChallengeRepository', () => ({ findChallengeByProjectRoundAndUser: mocks.findChallenge }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mocks.findProject }));
vi.mock('../../services/evidencePhotoCapture.service', () => ({ processCapturedEvidencePhotos: mocks.processPhotos, cleanupCapturedEvidencePhotos: mocks.cleanupPhotos }));
vi.mock('../../utils/mongoTransaction', () => ({ runMongoTransaction: mocks.transaction }));

import { submitAuditorListingVerification } from '../../services/auditorListingVerification.service';

/** Tạo payload ảnh tối thiểu sau khi evidence pipeline đã xác thực camera và GPS. */
function photo(): CapturedEvidencePhotoInput & { cid: string; contentSha256: string; capturedAt: Date; clockSkewSeconds: number } {
  return {
    cid: 'cid-1', contentSha256: 'hash-1', contentBase64: 'unused', fileName: 'evidence.jpg', mimeType: 'image/jpeg',
    gps: { latitude: 10, longitude: 106 }, accuracyMeters: 5, lowAccuracyOverride: false,
    overrideUnlockedAfterMs: null, lowAccuracyReason: null, capturedAt: new Date(), capturedAtClient: new Date().toISOString(),
    geolocationTimestamp: new Date().toISOString(), clockSkewSeconds: 0
  };
}

describe('submitAuditorListingVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findProject.mockResolvedValue({ projectId: 'project-1', organizationId: 'organization-1', status: 'PENDING_ACTIVATION', listingRound: 1, activationEligibleAt: null });
    mocks.findVerification.mockResolvedValue(null);
    mocks.findChallenge.mockResolvedValue(null);
    mocks.processPhotos.mockResolvedValue([photo()]);
    mocks.createVerification.mockResolvedValue({ verificationId: 'verification-1' });
    mocks.createRegistry.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (session: unknown) => Promise<unknown>) => callback({}));
  });

  it('persists a confirmed record and registry evidence without mutating project state or opening arbitration', async () => {
    const result = await submitAuditorListingVerification('auditor-1', {
      projectId: 'project-1', note: 'Đã đối chiếu thực địa.', clientSubmittedAt: new Date().toISOString(), photos: [photo()]
    });

    expect(result).toEqual({ verificationId: 'verification-1', projectStatus: 'PENDING_ACTIVATION' });
    expect(mocks.createVerification).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', auditorUserId: 'auditor-1', verdict: 'CONFIRMED' }), expect.anything());
    expect(mocks.createRegistry).toHaveBeenCalledWith([expect.objectContaining({ module: 'LISTING_VERIFICATION', refId: 'verification-1' })], expect.anything());
  });

  it('rejects a second conclusion in the same listing round before evidence processing', async () => {
    mocks.findVerification.mockResolvedValue({ verificationId: 'existing' });

    await expect(submitAuditorListingVerification('auditor-1', {
      projectId: 'project-1', clientSubmittedAt: new Date().toISOString(), photos: [photo()]
    })).rejects.toMatchObject({ errorCode: 'DUPLICATE_SUBMISSION', statusCode: 409 });
    expect(mocks.processPhotos).not.toHaveBeenCalled();
  });

  it('cleans up Pinata evidence when Mongo persistence fails', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('Mongo transaction failed'));

    await expect(submitAuditorListingVerification('auditor-1', {
      projectId: 'project-1', clientSubmittedAt: new Date().toISOString(), photos: [photo()]
    })).rejects.toThrow('Mongo transaction failed');
    expect(mocks.cleanupPhotos).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ cid: 'cid-1' })]));
  });
});
