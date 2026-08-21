import {
  createAuditorFieldReport,
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
