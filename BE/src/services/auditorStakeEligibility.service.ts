import { findAllAuditorFieldReportsByAuditorUserIdFromRepository } from '../repositories/auditorFieldReportRepository';
import { findAuditorStakeGuardByUserId, type AuditorStakeGuard } from '../models/auditorStakeGuardModel';
import { findProjectStatusesByIdListFromRepository } from '../repositories/projectRepository';
import type { ProjectStatus } from '../models/projectModel';

/** Dự án còn sống mà Kiểm toán viên đã nộp ảnh xác minh thực địa thì chưa cho thoát vai trò. */
export const BLOCKING_PROJECT_STATUSES: ProjectStatus[] = ['ACTIVE', 'DISPUTED', 'PENDING_ACTIVATION'];

export interface AuditorExitEligibilityProjectTie {
  projectId: string;
  projectName: string;
  status: ProjectStatus;
}

export interface AuditorExitEligibilityReason {
  code: 'OPEN_DISPUTE' | 'PENALTY_DEBT' | 'ACTIVE_PROJECT_TIES';
  message: string;
  projectTies?: AuditorExitEligibilityProjectTie[];
}

export interface AuditorExitEligibilityResult {
  eligible: boolean;
  reasons: AuditorExitEligibilityReason[];
}

/**
 * Xét đủ điều kiện rút hết cọc và thoát hẳn vai trò Kiểm toán viên.
 * Gom đủ mọi lý do thay vì dừng ở lý do đầu tiên, để người dùng biết hết việc phải làm trong một lần
 * thay vì sửa xong cái này lại gặp cái kia.
 */
export async function evaluateAuditorFullExitEligibility(
  auditorUserId: string,
  options?: { guard?: AuditorStakeGuard | null }
): Promise<AuditorExitEligibilityResult> {
  const reasons: AuditorExitEligibilityReason[] = [];
  const guard = options && 'guard' in options ? options.guard : await findAuditorStakeGuardByUserId(auditorUserId);

  if (guard && guard.openCaseIds.length > 0) {
    reasons.push({
      code: 'OPEN_DISPUTE',
      message: `Còn ${guard.openCaseIds.length} vụ khiếu nại/tranh chấp đang mở.`
    });
  }
  if (guard && guard.penaltyDebtVnd > 0) {
    reasons.push({
      code: 'PENALTY_DEBT',
      message: `Còn nợ phạt ${guard.penaltyDebtVnd.toLocaleString('vi-VN')} VNĐ chưa thanh toán.`
    });
  }

  const fieldReports = await findAllAuditorFieldReportsByAuditorUserIdFromRepository(auditorUserId);
  const projectIds = [...new Set(fieldReports.map(report => report.projectId))];
  const activeTies = await findProjectStatusesByIdListFromRepository(projectIds, BLOCKING_PROJECT_STATUSES);
  if (activeTies.length > 0) {
    reasons.push({
      code: 'ACTIVE_PROJECT_TIES',
      message: `Còn ${activeTies.length} dự án chưa kết thúc gắn với ảnh xác minh thực địa đã nộp.`,
      projectTies: activeTies.map(project => ({
        projectId: project.projectId,
        projectName: project.name,
        status: project.status
      }))
    });
  }

  return { eligible: reasons.length === 0, reasons };
}
