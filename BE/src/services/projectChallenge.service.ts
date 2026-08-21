import { AUDITOR_ROLE } from '../constants/governanceRoles';
import { PROJECT_CHALLENGE_DAILY_LIMIT } from '../constants/projectListingPolicy';
import { ProjectArbitrationMongoModel } from '../models/projectArbitrationModel';
import { countProjectChallengesByUserSinceFromRepository, createProjectChallengeFromRepository, findChallengeByProjectRoundAndUser } from '../repositories/projectChallengeRepository';
import { createEvidencePhotoRegistryRecordsFromRepository } from '../repositories/evidencePhotoRegistryRepository';
import { findProjectById, updateProjectIfStatus } from '../repositories/projectRepository';
import { ApplicationError } from '../utils/applicationError';
import { openArbitrationCase } from './projectArbitration.service';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { processCapturedEvidencePhotos, type CapturedEvidencePhotoInput } from './evidencePhotoCapture.service';

interface MongoDuplicateKeyError {
  code?: number;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  writeErrors?: Array<{ err?: { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> } }>;
}

/** Lấy đầu ngày UTC để quota nghiệp vụ không phụ thuộc timezone của server. */
function getUtcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Ghi nhận khiếu nại auditor và khóa dự án trước khi worker có thể kích hoạt. */
export async function submitProjectChallenge(
  auditorUserId: string,
  payload: { projectId: string; reason: string; photos?: CapturedEvidencePhotoInput[]; clientSubmittedAt?: string; serverReceivedAt?: Date }
): Promise<{ challengeId: string; arbitrationId: string | null; projectStatus: string }> {
  const serverReceivedAt = payload.serverReceivedAt || new Date();
  const project = await findProjectById(payload.projectId);
  if (!project) throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  if (project.status === 'ACTIVE') throw new ApplicationError('Cửa sổ khiếu nại đã đóng.', 409, 'CHALLENGE_WINDOW_CLOSED');
  if (project.status !== 'PENDING_ACTIVATION' && project.status !== 'DISPUTED') {
    throw new ApplicationError('Dự án không ở trạng thái có thể khiếu nại.', 409, 'INVALID_STATUS_TRANSITION');
  }
  if (project.status === 'PENDING_ACTIVATION' && project.activationEligibleAt && project.activationEligibleAt <= serverReceivedAt) {
    throw new ApplicationError('Cửa sổ khiếu nại đã đóng.', 409, 'CHALLENGE_WINDOW_CLOSED');
  }
  if (project.organizationId === auditorUserId) throw new ApplicationError('Không thể khiếu nại dự án của chính mình.', 403, 'FORBIDDEN');

  const round = Math.max(1, project.listingRound || 1);
  if (await findChallengeByProjectRoundAndUser(project.projectId, round, auditorUserId)) {
    throw new ApplicationError('Bạn đã khiếu nại dự án này trong vòng niêm yết hiện tại.', 409, 'DUPLICATE_SUBMISSION');
  }

  if (await countProjectChallengesByUserSinceFromRepository(auditorUserId, getUtcDayStart(serverReceivedAt)) >= PROJECT_CHALLENGE_DAILY_LIMIT) {
    throw new ApplicationError('Bạn đã đạt hạn mức khiếu nại trong ngày.', 429, 'RATE_LIMIT_EXCEEDED');
  }
  const evidencePhotos = await processCapturedEvidencePhotos({
    photos: payload.photos || [],
    module: 'PROJECT_CHALLENGE',
    ownerUserId: auditorUserId,
    clientSubmittedAt: payload.clientSubmittedAt || serverReceivedAt.toISOString(),
    serverReceivedAt
  });
  const challengeEvidence = evidencePhotos.map(({ lowAccuracyOverride, ...photo }) => ({ ...photo, isLowAccuracyOverride: lowAccuracyOverride }));

  try {
    return await runMongoTransaction(async session => {
      if (project.status === 'DISPUTED') {
        const caseRecord = await ProjectArbitrationMongoModel.findOne({ projectId: project.projectId, round, status: 'PENDING' }).session(session || null).lean().exec();
        if (!caseRecord) throw new ApplicationError('Vụ xét xử của vòng niêm yết này đã đóng.', 409, 'INVALID_STATUS_TRANSITION');

        const challenge = await createProjectChallengeFromRepository({
          projectId: project.projectId, round, challengerUserId: auditorUserId, challengerRoleAtSubmit: AUDITOR_ROLE,
          reason: payload.reason, evidencePhotos: challengeEvidence, submittedAt: serverReceivedAt
        }, session);
        await createEvidencePhotoRegistryRecordsFromRepository(
          evidencePhotos.map(photo => ({ contentSha256: photo.contentSha256, cid: photo.cid, module: 'PROJECT_CHALLENGE', ownerUserId: auditorUserId, refId: challenge.challengeId, createdAt: serverReceivedAt })),
          session
        );
        return { challengeId: challenge.challengeId, arbitrationId: caseRecord.arbitrationId, projectStatus: 'DISPUTED' };
      }

      const challenge = await createProjectChallengeFromRepository({
        projectId: project.projectId, round, challengerUserId: auditorUserId, challengerRoleAtSubmit: AUDITOR_ROLE,
        reason: payload.reason, evidencePhotos: challengeEvidence, submittedAt: serverReceivedAt
      }, session);
      await createEvidencePhotoRegistryRecordsFromRepository(
        evidencePhotos.map(photo => ({ contentSha256: photo.contentSha256, cid: photo.cid, module: 'PROJECT_CHALLENGE', ownerUserId: auditorUserId, refId: challenge.challengeId, createdAt: serverReceivedAt })),
        session
      );
      const locked = await updateProjectIfStatus(project.projectId, 'PENDING_ACTIVATION', {
        status: 'DISPUTED', activationEligibleAt: null, activationClaimedAt: null, updatedAt: serverReceivedAt
      }, session);
      if (!locked) throw new ApplicationError('Dự án đã thay đổi trạng thái, vui lòng thử lại.', 409, 'INVALID_STATUS_TRANSITION');

      const arbitration = await openArbitrationCase(project.projectId, round, challenge.challengeId, session);
      return { challengeId: challenge.challengeId, arbitrationId: arbitration.arbitrationId, projectStatus: 'DISPUTED' };
    });
  } catch (error) {
    const duplicateKeyError = error as MongoDuplicateKeyError;
    const nestedDuplicateError = duplicateKeyError.writeErrors?.[0]?.err;
    const keyPattern = duplicateKeyError.keyPattern || nestedDuplicateError?.keyPattern;
    const keyValue = duplicateKeyError.keyValue || nestedDuplicateError?.keyValue;
    if (duplicateKeyError.code === 11000 && (keyPattern?.contentSha256 || keyValue?.contentSha256)) {
      throw new ApplicationError('Ảnh này đã được dùng cho bản ghi khác.', 409, 'DUPLICATE_EVIDENCE_PHOTO');
    }
    if (duplicateKeyError.code === 11000) {
      throw new ApplicationError('Bạn đã khiếu nại dự án này trong vòng niêm yết hiện tại.', 409, 'DUPLICATE_SUBMISSION');
    }
    throw error;
  }
}
