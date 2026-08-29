import { createAuditorFieldReportFromRepository, findAuditorFieldReportByProjectIdFromRepository } from '../repositories/auditorFieldReportRepository';
import { createEvidencePhotoRegistryRecordsFromRepository } from '../repositories/evidencePhotoRegistryRepository';
import { findProjectById } from '../repositories/projectRepository';
import { ApplicationError } from '../utils/applicationError';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { cleanupCapturedEvidencePhotos, processCapturedEvidencePhotos, type CapturedEvidencePhotoInput, type StoredEvidencePhoto } from './evidencePhotoCapture.service';

/** Nộp biên bản hiện trường bằng evidence camera cho một dự án ACTIVE đúng một lần. */
export async function submitAuditorFieldReport(auditorUserId: string, payload: {
  projectId: string;
  note: string;
  verifiedMilestoneIndexes: number[];
  photos: CapturedEvidencePhotoInput[];
  clientSubmittedAt: string;
  serverReceivedAt?: Date;
}): Promise<{ reportId: string }> {
  const project = await findProjectById(payload.projectId);
  if (!project) throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  if (project.status !== 'ACTIVE') throw new ApplicationError('Chỉ dự án ACTIVE mới được nộp biên bản hiện trường.', 409, 'INVALID_STATUS_TRANSITION');
  if (await findAuditorFieldReportByProjectIdFromRepository(project.projectId)) throw new ApplicationError('Dự án này đã có biên bản kiểm tra thực địa.', 409, 'FIELD_REPORT_ALREADY_EXISTS');
  const planIndexes = new Set<number>((project.milestonePlan || []).map(item => item.milestoneIndex));
  if (!planIndexes.size) throw new ApplicationError('Dự án chưa có kế hoạch cột mốc để đối chiếu.', 409, 'MILESTONE_PLAN_REQUIRED');
  if (new Set(payload.verifiedMilestoneIndexes).size !== payload.verifiedMilestoneIndexes.length) throw new ApplicationError('Không được chọn trùng cột mốc.', 400, 'VALIDATION_ERROR');
  if (payload.verifiedMilestoneIndexes.some(index => !planIndexes.has(index))) throw new ApplicationError('Có cột mốc không thuộc kế hoạch dự án.', 404, 'MILESTONE_NOT_FOUND');

  const serverReceivedAt = payload.serverReceivedAt || new Date();
  let evidencePhotos: StoredEvidencePhoto[] = [];
  try {
    evidencePhotos = await processCapturedEvidencePhotos({
      photos: payload.photos,
      module: 'AUDITOR_FIELD_REPORT',
      ownerUserId: auditorUserId,
      clientSubmittedAt: payload.clientSubmittedAt,
      serverReceivedAt
    });
    const reportPhotos = evidencePhotos.map(({ lowAccuracyOverride, ...photo }) => ({ ...photo, isLowAccuracyOverride: lowAccuracyOverride }));
    return await runMongoTransaction(async session => {
      const report = await createAuditorFieldReportFromRepository({
        projectId: project.projectId,
        auditorUserId,
        note: payload.note,
        verifiedMilestoneIndexes: payload.verifiedMilestoneIndexes,
        photos: reportPhotos,
        submittedAt: serverReceivedAt
      }, session);
      await createEvidencePhotoRegistryRecordsFromRepository(evidencePhotos.map(photo => ({
        contentSha256: photo.contentSha256,
        cid: photo.cid,
        module: 'AUDITOR_FIELD_REPORT',
        ownerUserId: auditorUserId,
        refId: report.reportId,
        createdAt: serverReceivedAt
      })), session);
      return { reportId: report.reportId };
    });
  } catch (error) {
    await cleanupCapturedEvidencePhotos(evidencePhotos);
    const duplicateKeyError = error as { code?: number; writeErrors?: Array<{ err?: { keyPattern?: Record<string, unknown> } }>; keyPattern?: Record<string, unknown> };
    const keyPattern = duplicateKeyError.keyPattern || duplicateKeyError.writeErrors?.[0]?.err?.keyPattern;
    if (duplicateKeyError.code === 11000 && keyPattern?.contentSha256) throw new ApplicationError('Ảnh này đã được dùng cho bản ghi khác.', 409, 'DUPLICATE_EVIDENCE_PHOTO');
    if (duplicateKeyError.code === 11000) throw new ApplicationError('Dự án này đã có biên bản kiểm tra thực địa.', 409, 'FIELD_REPORT_ALREADY_EXISTS');
    throw error;
  }
}
