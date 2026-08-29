 import mongoose, { Schema } from 'mongoose';

export type ProjectStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'PENDING_ACTIVATION' | 'DISPUTED' | 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'REJECTED';

export type ProjectMilestonePlanItem = {
  milestoneIndex: 1 | 2 | 3;
  milestoneKey: 'M1_ADVANCE' | 'M2_CONSTRUCTION' | 'M3_HANDOVER';
  percentage: number;
  description: string;
};

export type ProjectEvidenceFileRecord = {
  cid: string;
  fileName: string;
  mimeType: string;
};

export type ProjectRecord = {
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
  milestonePlan?: ProjectMilestonePlanItem[];
  listedAt?: Date | null;
  activationEligibleAt?: Date | null;
  activationClaimedAt?: Date | null;
  activationState?: 'NOT_STARTED' | 'SYNCED' | 'FAILED';
  activationAttemptCount?: number;
  activationLastAttemptAt?: Date | null;
  activationLastError?: string | null;
  listingRound?: number;
  closureState?: 'NOT_REQUIRED' | 'PENDING' | 'SYNCED' | 'FAILED';
  closureClaimedAt?: Date | null;
  closureAttemptCount?: number;
  closureNextAttemptAt?: Date | null;
  closureLastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FeedbackProjectRecord = Pick<ProjectRecord, 'projectId' | 'organizationId' | 'name' | 'status'>;

const projectSchema = new Schema<ProjectRecord>({
  projectId: { type: String, required: true, unique: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  goalAmount: { type: Number, required: true },
  deadline: { type: Date, required: true },
  status: { type: String, required: true, index: true },
  evidenceCids: { type: [String], required: true },
  evidenceFiles: {
    type: [
      {
        cid: { type: String, required: true },
        fileName: { type: String, required: true },
        mimeType: { type: String, required: true }
      }
    ],
    default: []
  },
  submittedAt: { type: Date, default: null },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: null },
  rejectionReason: { type: String, default: null },
  milestonePlan: {
    type: [{
      milestoneIndex: { type: Number, required: true, enum: [1, 2, 3] },
      milestoneKey: { type: String, required: true, enum: ['M1_ADVANCE', 'M2_CONSTRUCTION', 'M3_HANDOVER'] },
      percentage: { type: Number, required: true },
      description: { type: String, required: true }
    }],
    default: []
  },
  listedAt: { type: Date, default: null },
  activationEligibleAt: { type: Date, default: null },
  activationClaimedAt: { type: Date, default: null },
  activationState: { type: String, enum: ['NOT_STARTED', 'SYNCED', 'FAILED'], default: 'NOT_STARTED' },
  activationAttemptCount: { type: Number, default: 0 },
  activationLastAttemptAt: { type: Date, default: null },
  activationLastError: { type: String, default: null },
  listingRound: { type: Number, default: 0 },
  closureState: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'SYNCED', 'FAILED'], default: 'NOT_REQUIRED' },
  closureClaimedAt: { type: Date, default: null },
  closureAttemptCount: { type: Number, default: 0 },
  closureNextAttemptAt: { type: Date, default: null },
  closureLastError: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

projectSchema.index({ organizationId: 1, name: 1 }, { unique: true });
projectSchema.index({ status: 1, activationEligibleAt: 1 });
projectSchema.index({ status: 1, closureState: 1, closureNextAttemptAt: 1 });
// Cursor portal Ủy ban luôn đi theo status + projectId; index này giữ pagination O(log n) khi dữ liệu tăng.
projectSchema.index({ status: 1, projectId: 1 });

export const ProjectMongoModel = mongoose.models?.Project
  || mongoose.model<ProjectRecord>('Project', projectSchema);

/** Hàm tạo filter thời gian cho project public. Mục đích: tránh ẩn toàn bộ dự án chỉ vì deadline vừa quá hạn trong thời gian ngắn. */
function createPublicProjectDeadlineFilter(): { $gte: Date } {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  return { $gte: sixtyDaysAgo };
}

/** Hàm tìm dự án theo tên trong cùng tổ chức. Mục đích: chặn trùng tên dự án theo nghiệp vụ. */
export async function findProjectByOrganizationIdAndName(organizationId: string, name: string): Promise<ProjectRecord | null> {
  return ProjectMongoModel.findOne({ organizationId, name }).lean<ProjectRecord>().exec();
}

/** Hàm tìm dự án theo projectId. Mục đích: dùng cho submit và review dự án. */
export async function findProjectByProjectId(projectId: string): Promise<ProjectRecord | null> {
  return ProjectMongoModel.findOne({ projectId }).lean<ProjectRecord>().exec();
}

/** Lấy đúng các trường cần cho feedback công khai, tránh đọc evidence và metadata của project. */
export async function findFeedbackProjectByProjectId(projectId: string): Promise<FeedbackProjectRecord | null> {
  return ProjectMongoModel.findOne(
    { projectId },
    { _id: 0, projectId: 1, organizationId: 1, name: 1, status: 1 }
  )
    .lean<FeedbackProjectRecord>()
    .exec();
}

/** Hàm đếm số dự án theo trạng thái. Mục đích: cung cấp số liệu thật cho metric dashboard quản trị. */
export async function countProjectsByStatus(status: ProjectStatus): Promise<number> {
  return ProjectMongoModel.countDocuments({ status }).exec();
}

/** Hàm tạo mới bản ghi dự án. Mục đích: lưu dữ liệu dự án vào MongoDB theo chuẩn repository. */
export async function createProjectRecord(projectRecord: ProjectRecord): Promise<ProjectRecord> {
  const createdProject = await ProjectMongoModel.create(projectRecord);
  return createdProject.toObject() as ProjectRecord;
}

/** Hàm lấy danh sách dự án theo tổ chức. Mục đích: phục vụ màn hình quản lý dự án với dữ liệu thật từ backend. */
export async function findProjectsByOrganizationId(organizationId: string): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({ organizationId }).sort({ createdAt: -1 }).lean<ProjectRecord[]>().exec();
}

/** Hàm lấy danh sách dự án theo trạng thái. Mục đích: phục vụ màn hình reviewer duyệt dự án chờ phê duyệt. */
export async function findProjectsByStatus(status: ProjectStatus): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({ status }).sort({ submittedAt: -1, createdAt: -1 }).lean<ProjectRecord[]>().exec();
}

/** Lấy một trang ACTIVE bằng cursor projectId và projection tối thiểu để dashboard Ủy ban không tải toàn bộ collection. */
export async function findProjectsByStatusCursor(
  status: ProjectStatus,
  cursor: string | null,
  limitCount: number
): Promise<Array<Pick<ProjectRecord, 'projectId' | 'name' | 'organizationId' | 'milestonePlan'>>> {
  return ProjectMongoModel.find(
    { status, ...(cursor ? { projectId: { $gt: cursor } } : {}) },
    { _id: 0, projectId: 1, name: 1, organizationId: 1, milestonePlan: 1 }
  )
    .sort({ projectId: 1 })
    .limit(limitCount)
    .lean<Array<Pick<ProjectRecord, 'projectId' | 'name' | 'organizationId' | 'milestonePlan'>>>()
    .exec();
}

/** Hàm lấy danh sách dự án theo nhiều trạng thái review để Regulatory theo dõi cả queue đang chờ và lịch sử đã xử lý. */
export async function findProjectsByStatusList(statusList: ProjectStatus[]): Promise<ProjectRecord[]> {
  if (!statusList.length) {
    return [];
  }

  return ProjectMongoModel.find({ status: { $in: statusList } })
    .sort({ reviewedAt: -1, submittedAt: -1, createdAt: -1 })
    .lean<ProjectRecord[]>()
    .exec();
}

/** Hàm lấy danh sách dự án active công khai. Mục đích: trả dữ liệu thật cho section “Dự án đang cần hỗ trợ” tại trang chủ. */
export async function findPublicSupportProjects(limitCount: number): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({
    status: 'ACTIVE',
    deadline: createPublicProjectDeadlineFilter()
  })
    .sort({ updatedAt: -1 })
    .limit(limitCount)
    .lean<ProjectRecord[]>()
    .exec();
}

/** Hàm lấy chi tiết dự án active công khai theo projectId. Mục đích: phục vụ modal chi tiết ở trang chủ. */
export async function findPublicSupportProjectByProjectId(projectId: string): Promise<ProjectRecord | null> {
  return ProjectMongoModel.findOne({
    projectId,
    status: 'ACTIVE',
    deadline: createPublicProjectDeadlineFilter()
  })
    .lean<ProjectRecord>()
    .exec();
}

/** Lấy dự án đang niêm yết công khai, tách khỏi danh sách dự án có thể nhận quyên góp. */
export async function findPendingActivationProjectsForPublic(limitCount: number): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({ status: { $in: ['PENDING_ACTIVATION', 'DISPUTED'] } })
    .sort({ activationEligibleAt: 1 })
    .limit(limitCount)
    .lean<ProjectRecord[]>()
    .exec();
}

/** Lấy các dự án đủ hạn kích hoạt theo index worker. */
export async function findProjectsReadyForActivation(now: Date, limitCount: number): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({ status: 'PENDING_ACTIVATION', activationEligibleAt: { $lte: now } })
    .sort({ activationEligibleAt: 1 })
    .limit(limitCount)
    .lean<ProjectRecord[]>()
    .exec();
}

/** Lấy batch dự án đã bị hủy sau khi ACTIVE nhưng chưa đồng bộ trạng thái Closed lên blockchain. */
export async function findRejectedProjectsNeedingClosure(now: Date, limitCount: number): Promise<ProjectRecord[]> {
  return ProjectMongoModel.find({
    status: 'REJECTED',
    closureState: { $in: ['PENDING', 'FAILED'] },
    $or: [{ closureNextAttemptAt: null }, { closureNextAttemptAt: { $lte: now } }]
  })
    .sort({ closureNextAttemptAt: 1, projectId: 1 })
    .limit(limitCount)
    .lean<ProjectRecord[]>()
    .exec();
}

/** Giành lease kích hoạt bằng CAS để nhiều instance worker không kích hoạt một dự án hai lần. */
export async function claimProjectForActivation(projectId: string, expectedStatus: ProjectStatus, staleClaimCutoff: Date): Promise<ProjectRecord | null> {
  const claimed = await ProjectMongoModel.findOneAndUpdate(
    {
      projectId,
      status: expectedStatus,
      // Dự án REJECTED đã bắt đầu đóng on-chain không được phép quay lại luồng kích hoạt.
      ...(expectedStatus === 'REJECTED' ? { closureState: { $in: [null, 'NOT_REQUIRED'] } } : {}),
      $or: [{ activationClaimedAt: null }, { activationClaimedAt: { $lt: staleClaimCutoff } }]
    },
    { $set: { activationClaimedAt: new Date() } },
    { returnDocument: 'after' }
  ).exec();
  return claimed ? claimed.toObject() as ProjectRecord : null;
}

/** Claim quyền đóng on-chain bằng CAS để nhiều worker không gửi cùng một giao dịch Closed. */
export async function claimProjectForClosure(projectId: string, staleClaimCutoff: Date): Promise<ProjectRecord | null> {
  return ProjectMongoModel.findOneAndUpdate(
    {
      projectId,
      status: 'REJECTED',
      closureState: { $in: ['PENDING', 'FAILED'] },
      $or: [{ closureClaimedAt: null }, { closureClaimedAt: { $lt: staleClaimCutoff } }]
    },
    { $set: { closureClaimedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean<ProjectRecord>().exec();
}

/** Chuyển dự án sang DISPUTED chỉ khi nó còn trong cửa sổ niêm yết. */
export async function updateProjectByProjectIdIfStatus(projectId: string, expectedStatus: ProjectStatus, payload: Partial<ProjectRecord>, session?: mongoose.ClientSession): Promise<ProjectRecord | null> {
  const updated = await ProjectMongoModel.findOneAndUpdate({ projectId, status: expectedStatus }, payload, { returnDocument: 'after', session }).exec();
  return updated ? updated.toObject() as ProjectRecord : null;
}

/** Hàm lấy danh sách dự án active theo nhiều projectId. Mục đích: lọc đúng tập dự án hợp lệ trước khi tính bảng xếp hạng. */
export async function findActiveProjectsByProjectIdList(projectIdList: string[]): Promise<ProjectRecord[]> {
  if (!projectIdList.length) {
    return [];
  }

  return ProjectMongoModel.find({
    projectId: { $in: projectIdList },
    status: 'ACTIVE',
    deadline: createPublicProjectDeadlineFilter()
  })
    .lean<ProjectRecord[]>()
    .exec();
}

/**
 * Hàm lấy tất cả dự án (bất kể trạng thái) theo danh sách projectId.
 * Mục đích: phục vụ bảng xếp hạng QF — không giới hạn theo status hay deadline.
 *
 * Logic lọc deadline:
 * - Project không có deadline → luôn hiển thị (không bị giới hạn thời gian)
 * - Project có deadline trong vòng 30 ngày qua hoặc tương lai → hiển thị
 * - Project có deadline quá 30 ngày trước → KHÔNG hiển thị (đã hết hạn quá lâu)
 *
 * Nhờ vậy, bảng xếp hạng luôn tươi mới, phản ánh đúng thời điểm hiện tại.
 */
export async function findAllProjectsByProjectIdList(projectIdList: string[]): Promise<ProjectRecord[]> {
  if (!projectIdList.length) {
    return [];
  }

  // Tính ngưỡng: deadline phải >= (hiện tại - 30 ngày) mới hiển thị.
  // Project hết deadline quá 30 ngày → không xuất hiện trong bảng xếp hạng.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return ProjectMongoModel.find({
    projectId: { $in: projectIdList },
    $or: [
      { deadline: null },
      { deadline: undefined },
      { deadline: { $gte: thirtyDaysAgo } }
    ]
  })
    .lean<ProjectRecord[]>()
    .exec();
}


/**
 * Lấy tên project theo lô mà không lọc trạng thái hoặc deadline.
 * Mục đích: gallery vẫn hiển thị đúng tên của project đã hoàn thành hoặc đã đóng.
 */
export async function findProjectNamesByProjectIdList(
  projectIdList: string[]
): Promise<Array<Pick<ProjectRecord, 'projectId' | 'name'>>> {
  if (!projectIdList.length) {
    return [];
  }

  return ProjectMongoModel.find(
    { projectId: { $in: projectIdList } },
    { _id: 0, projectId: 1, name: 1 }
  )
    .lean<Array<Pick<ProjectRecord, 'projectId' | 'name'>>>()
    .exec();
}

/**
 * Lấy các dự án trong danh sách đang ở một trong các trạng thái cần xét, kèm tên để hiển thị.
 * Không lọc deadline như findAllProjectsByProjectIdList: điều kiện ràng buộc phải thấy cả dự án
 * đã quá hạn từ lâu mà vẫn chưa đóng, nếu không auditor sẽ thoát vai trò khi ràng buộc còn nguyên.
 */
export async function findProjectStatusesByProjectIdList(
  projectIdList: string[],
  statusList: ProjectStatus[]
): Promise<Array<Pick<ProjectRecord, 'projectId' | 'name' | 'status'>>> {
  if (!projectIdList.length || !statusList.length) {
    return [];
  }

  return ProjectMongoModel.find(
    { projectId: { $in: projectIdList }, status: { $in: statusList } },
    { _id: 0, projectId: 1, name: 1, status: 1 }
  )
    .lean<Array<Pick<ProjectRecord, 'projectId' | 'name' | 'status'>>>()
    .exec();
}

/** Hàm cập nhật dự án theo projectId. Mục đích: cập nhật trạng thái vòng đời và metadata review. */
export async function updateProjectByProjectId(
  projectId: string,
  payload: Partial<ProjectRecord>
): Promise<ProjectRecord | null> {
  const updatedProject = await ProjectMongoModel.findOneAndUpdate({ projectId }, payload, { returnDocument: 'after' }).exec();
  return updatedProject ? (updatedProject.toObject() as ProjectRecord) : null;
}
