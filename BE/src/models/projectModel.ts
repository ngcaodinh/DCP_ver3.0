 import mongoose, { Schema } from 'mongoose';

export type ProjectStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'REJECTED';

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
  createdAt: Date;
  updatedAt: Date;
};

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
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

projectSchema.index({ organizationId: 1, name: 1 }, { unique: true });

const ProjectMongoModel = mongoose.model<ProjectRecord>('Project', projectSchema);

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

/** Hàm đếm số dự án ACTIVE của tổ chức. Mục đích: enforce giới hạn tối đa 5 dự án ACTIVE. */
export async function countActiveProjectsByOrganizationId(organizationId: string): Promise<number> {
  return ProjectMongoModel.countDocuments({ organizationId, status: 'ACTIVE' }).exec();
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

/** Hàm cập nhật dự án theo projectId. Mục đích: cập nhật trạng thái vòng đời và metadata review. */
export async function updateProjectByProjectId(
  projectId: string,
  payload: Partial<ProjectRecord>
): Promise<ProjectRecord | null> {
  const updatedProject = await ProjectMongoModel.findOneAndUpdate({ projectId }, payload, { returnDocument: 'after' }).exec();
  return updatedProject ? (updatedProject.toObject() as ProjectRecord) : null;
}
