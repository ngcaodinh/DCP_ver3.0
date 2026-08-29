import { createAuditorListingVerification, findListingVerificationByProjectRoundAndUser, type AuditorListingVerificationPhoto } from '../models/auditorListingVerificationModel';
import { createEvidencePhotoRegistryRecordsFromRepository } from '../repositories/evidencePhotoRegistryRepository';
import { findChallengeByProjectRoundAndUser } from '../repositories/projectChallengeRepository';
import { findProjectById } from '../repositories/projectRepository';
import { ApplicationError } from '../utils/applicationError';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { cleanupCapturedEvidencePhotos, processCapturedEvidencePhotos, type CapturedEvidencePhotoInput, type StoredEvidencePhoto } from './evidencePhotoCapture.service';

interface MongoDuplicateKeyError { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown>; }

/** Ghi nhận xác minh tích cực mà không thay đổi trạng thái dự án hoặc mở vụ xét xử. */
export async function submitAuditorListingVerification(
  auditorUserId: string,
  payload: { projectId: string; note?: string; photos: CapturedEvidencePhotoInput[]; clientSubmittedAt: string }
): Promise<{ verificationId: string; projectStatus: string }> {
  const serverReceivedAt = new Date();
  const project = await findProjectById(payload.projectId);
  if (!project) throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  if (project.status === 'ACTIVE' || (project.status === 'PENDING_ACTIVATION' && project.activationEligibleAt && project.activationEligibleAt <= serverReceivedAt)) {
    throw new ApplicationError('Cửa sổ khiếu nại đã đóng.', 409, 'CHALLENGE_WINDOW_CLOSED');
  }
  if (project.status !== 'PENDING_ACTIVATION' && project.status !== 'DISPUTED') throw new ApplicationError('Dự án không ở trạng thái có thể xác minh.', 409, 'INVALID_STATUS_TRANSITION');
  if (project.organizationId === auditorUserId) throw new ApplicationError('Không thể xác minh dự án của chính mình.', 403, 'FORBIDDEN');
  const round = Math.max(1, project.listingRound || 1);
  if (await findListingVerificationByProjectRoundAndUser(project.projectId, round, auditorUserId) || await findChallengeByProjectRoundAndUser(project.projectId, round, auditorUserId)) {
    throw new ApplicationError('Bạn đã xác minh dự án này trong vòng niêm yết hiện tại.', 409, 'DUPLICATE_SUBMISSION');
  }
  let evidencePhotos: StoredEvidencePhoto[] = [];
  try {
    evidencePhotos = await processCapturedEvidencePhotos({
      photos: payload.photos, module: 'LISTING_VERIFICATION', ownerUserId: auditorUserId,
      clientSubmittedAt: payload.clientSubmittedAt, serverReceivedAt
    });
    const photos: AuditorListingVerificationPhoto[] = evidencePhotos.map(({ lowAccuracyOverride, ...photo }) => ({ ...photo, isLowAccuracyOverride: lowAccuracyOverride }));
    const verification = await runMongoTransaction(async session => {
      const created = await createAuditorListingVerification({
        projectId: project.projectId, round, auditorUserId, verdict: 'CONFIRMED', note: payload.note?.trim() || null,
        photos, submittedAt: serverReceivedAt
      }, session);
      await createEvidencePhotoRegistryRecordsFromRepository(evidencePhotos.map(photo => ({
        contentSha256: photo.contentSha256, cid: photo.cid, module: 'LISTING_VERIFICATION', ownerUserId: auditorUserId,
        refId: created.verificationId, createdAt: serverReceivedAt
      })), session);
      return created;
    });
    return { verificationId: verification.verificationId, projectStatus: project.status };
  } catch (error) {
    await cleanupCapturedEvidencePhotos(evidencePhotos);
    const duplicate = error as MongoDuplicateKeyError;
    if (duplicate.code === 11000 && (duplicate.keyPattern?.contentSha256 || duplicate.keyValue?.contentSha256)) {
      throw new ApplicationError('Ảnh này đã được dùng cho bản ghi khác.', 409, 'DUPLICATE_EVIDENCE_PHOTO');
    }
    if (duplicate.code === 11000) throw new ApplicationError('Bạn đã xác minh dự án này trong vòng niêm yết hiện tại.', 409, 'DUPLICATE_SUBMISSION');
    throw error;
  }
}
