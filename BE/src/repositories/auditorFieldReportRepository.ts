import {
  createAuditorFieldReport,
  findAllAuditorFieldReportsByAuditorUserId,
  findAuditorFieldReportByProjectId,
  findAuditorFieldReportsByProjectIds,
  type AuditorFieldReportRecord
} from '../models/auditorFieldReportModel';
import { type ClientSession } from 'mongoose';

/** Lưu biên bản hiện trường qua repository để cô lập MongoDB khỏi service. */
export async function createAuditorFieldReportFromRepository(
  payload: Omit<AuditorFieldReportRecord, 'reportId' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<AuditorFieldReportRecord> {
  return createAuditorFieldReport(payload, session);
}

/** Lấy biên bản duy nhất của dự án. */
export async function findAuditorFieldReportByProjectIdFromRepository(projectId: string): Promise<AuditorFieldReportRecord | null> {
  return findAuditorFieldReportByProjectId(projectId);
}

/** Lấy batch biên bản hiện trường theo dự án cho màn hình Auditor. */
export async function findAuditorFieldReportsByProjectIdsFromRepository(projectIds: string[]): Promise<AuditorFieldReportRecord[]> {
  return findAuditorFieldReportsByProjectIds(projectIds);
}

/** Lấy toàn bộ biên bản của một auditor để xét ràng buộc thoát vai trò, không giới hạn bản ghi. */
export async function findAllAuditorFieldReportsByAuditorUserIdFromRepository(auditorUserId: string): Promise<AuditorFieldReportRecord[]> {
  return findAllAuditorFieldReportsByAuditorUserId(auditorUserId);
}
