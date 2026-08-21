import { type ClientSession } from 'mongoose';
import {
  countActiveProjectsByOrganizationId,
  createProjectRecord,
  findProjectByOrganizationIdAndName,
  findProjectByProjectId,
  findProjectsByOrganizationId,
  findProjectsByStatus,
  findProjectsByStatusList,
  findPendingActivationProjectsForPublic,
  findProjectsReadyForActivation,
  claimProjectForActivation,
  findPublicSupportProjectByProjectId,
  findPublicSupportProjects,
  findAllProjectsByProjectIdList,
  ProjectEvidenceFileRecord,
  ProjectRecord,
  ProjectStatus,
  updateProjectByProjectId,
  updateProjectByProjectIdIfStatus
} from '../models/projectModel';

export type CreateProjectDataAccessPayload = {
  projectId: string;
  organizationId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline: Date;
  status: ProjectStatus;
  evidenceCids: string[];
  evidenceFiles: ProjectEvidenceFileRecord[];
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  milestonePlan?: ProjectRecord['milestonePlan'];
  listedAt?: Date | null;
  activationEligibleAt?: Date | null;
  activationClaimedAt?: Date | null;
  activationState?: ProjectRecord['activationState'];
  activationAttemptCount?: number;
  activationLastAttemptAt?: Date | null;
  activationLastError?: string | null;
  listingRound?: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Hàm repository tìm dự án theo tên trong tổ chức. Mục đích: tách data-access khỏi lớp service để dễ test. */
export async function findProjectByOrganizationAndName(organizationId: string, name: string): Promise<ProjectRecord | null> {
  return findProjectByOrganizationIdAndName(organizationId, name);
}

/** Hàm repository tìm dự án theo projectId. Mục đích: hỗ trợ submit/review vòng đời dự án. */
export async function findProjectById(projectId: string): Promise<ProjectRecord | null> {
  return findProjectByProjectId(projectId);
}

/** Hàm repository tìm nhiều dự án theo danh sách projectId (batch query với $in). Mục đích: giảm N+1 queries. */
export async function findProjectsByIdList(projectIdList: string[]): Promise<ProjectRecord[]> {
  return findAllProjectsByProjectIdList(projectIdList);
}

/** Hàm repository đếm số dự án ACTIVE theo tổ chức. Mục đích: enforce giới hạn 5 dự án ACTIVE. */
export async function countActiveProjectsByOrganizationIdFromRepository(organizationId: string): Promise<number> {
  return countActiveProjectsByOrganizationId(organizationId);
}

/** Hàm repository tạo mới dự án. Mục đích: chuẩn hóa payload trước khi gọi model MongoDB. */
export async function createProject(payload: CreateProjectDataAccessPayload): Promise<ProjectRecord> {
  return createProjectRecord(payload);
}

/** Hàm repository lấy danh sách dự án theo organizationId. Mục đích: tách data-access cho luồng hiển thị danh sách dự án thật. */
export async function findProjectsByOrganizationIdFromRepository(organizationId: string): Promise<ProjectRecord[]> {
  return findProjectsByOrganizationId(organizationId);
}

/** Hàm repository lấy danh sách dự án theo trạng thái. Mục đích: tách data-access cho màn hình duyệt dự án mới. */
export async function findProjectsByStatusFromRepository(status: ProjectStatus): Promise<ProjectRecord[]> {
  return findProjectsByStatus(status);
}

/** Hàm repository lấy queue review kèm dự án đã xử lý để Regulatory có lịch sử đầy đủ. */
export async function findProjectsByStatusListFromRepository(statusList: ProjectStatus[]): Promise<ProjectRecord[]> {
  return findProjectsByStatusList(statusList);
}

/** Hàm repository lấy danh sách dự án public đang cần hỗ trợ. Mục đích: cung cấp dữ liệu thật cho homepage không cần đăng nhập. */
export async function findPublicSupportProjectsFromRepository(limitCount: number): Promise<ProjectRecord[]> {
  return findPublicSupportProjects(limitCount);
}

/** Hàm repository lấy chi tiết dự án public theo projectId. Mục đích: cấp dữ liệu thật cho modal chi tiết ở homepage. */
export async function findPublicSupportProjectDetailFromRepository(projectId: string): Promise<ProjectRecord | null> {
  return findPublicSupportProjectByProjectId(projectId);
}

/** Lấy danh sách công khai đang niêm yết để người xem theo dõi giai đoạn chờ kích hoạt. */
export async function findPendingActivationProjectsForPublicFromRepository(limitCount: number): Promise<ProjectRecord[]> {
  return findPendingActivationProjectsForPublic(limitCount);
}

/** Lấy batch dự án đã qua cửa sổ khiếu nại để worker kích hoạt. */
export async function findProjectsReadyForActivationFromRepository(now: Date, limitCount: number): Promise<ProjectRecord[]> {
  return findProjectsReadyForActivation(now, limitCount);
}

/** Claim dự án nguyên tử để chỉ một instance sở hữu lần kích hoạt. */
export async function claimProjectForActivationFromRepository(projectId: string, expectedStatus: ProjectStatus, staleClaimCutoff: Date): Promise<ProjectRecord | null> {
  return claimProjectForActivation(projectId, expectedStatus, staleClaimCutoff);
}

/** Đổi trạng thái dự án có điều kiện để transaction khiếu nại không đè worker. */
export async function updateProjectIfStatus(projectId: string, expectedStatus: ProjectStatus, payload: Partial<ProjectRecord>, session?: ClientSession): Promise<ProjectRecord | null> {
  return updateProjectByProjectIdIfStatus(projectId, expectedStatus, payload, session);
}

/** Hàm repository cập nhật dự án theo projectId. Mục đích: cập nhật trạng thái submit/review. */
export async function updateProject(
  projectId: string,
  payload: Partial<ProjectRecord>
): Promise<ProjectRecord | null> {
  return updateProjectByProjectId(projectId, payload);
}
