import mongoose, { Schema } from 'mongoose';

export type OrganizationKycFile = {
  cid: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  documentType: string;
  version: number;
  uploadedBy: string;
  uploadedAt: Date;
  reviewStatus: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
};

export type OrganizationKycSubmission = {
  submissionId: string;
  organizationId: string;
  organizationName: string;
  legalRegistrationNumber: string;
  officialWebsite: string | null;
  organizationDescription: string;
  version: number;
  status:
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'RESUBMITTED'
  | 'SUBMISSION_ERROR';
  submittedBy: string;
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName: string | null;
  } | null;
  files: OrganizationKycFile[];
};

const organizationKycFileSchema = new Schema<OrganizationKycFile>({
  cid: { type: String, required: true },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  documentType: { type: String, required: true },
  version: { type: Number, required: true },
  uploadedBy: { type: String, required: true },
  uploadedAt: { type: Date, required: true },
  reviewStatus: { type: String, required: true },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null }
});

const organizationKycSubmissionSchema = new Schema<OrganizationKycSubmission>({
  submissionId: { type: String, required: true, unique: true },
  organizationId: { type: String, required: true, index: true },
  organizationName: { type: String, required: true },
  legalRegistrationNumber: { type: String, required: true },
  officialWebsite: { type: String, default: null },
  organizationDescription: { type: String, required: true },
  version: { type: Number, required: true },
  status: { type: String, required: true },
  submittedBy: { type: String, required: true },
  submittedAt: { type: Date, required: true },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  beneficiaryBankAccount: {
    bankName: { type: String, required: false },
    bankAccountNumber: { type: String, required: false },
    accountHolderName: { type: String, required: false },
    branchName: { type: String, default: null }
  },
  files: { type: [organizationKycFileSchema], required: true }
});

// Tạo partial unique index để đảm bảo mỗi cặp số tài khoản và tên ngân hàng chỉ được liên kết với một tổ chức.
// Chỉ apply lên documents có beneficiaryBankAccount hợp lệ, tránh collision với dữ liệu cũ.
// Dùng Object.assign để tránh lỗi TS "duplicate property name" khi dùng $ne nhiều lần trong object literal.
const bankAccountPartialFilter = Object.assign(
  {},
  { $exists: true },
  { $ne: null },
  { $ne: '' }
);
organizationKycSubmissionSchema.index(
  { 'beneficiaryBankAccount.bankAccountNumber': 1, 'beneficiaryBankAccount.bankName': 1 },
  Object.assign(
    {},
    { unique: true },
    {
      partialFilterExpression: {
        'beneficiaryBankAccount.bankAccountNumber': bankAccountPartialFilter,
        'beneficiaryBankAccount.bankName': bankAccountPartialFilter
      }
    }
  )
);

const OrganizationKycSubmissionModel = mongoose.model<OrganizationKycSubmission>(
  'OrganizationKycSubmission',
  organizationKycSubmissionSchema
);

/**
 * Hàm lấy phiên bản hồ sơ mới nhất của tổ chức.
 * Mục đích: tăng version đúng chuẩn khi tổ chức nộp lại hồ sơ.
 */
export async function getLatestSubmissionVersion(organizationId: string): Promise<number> {
  const latestSubmission = await OrganizationKycSubmissionModel.findOne({ organizationId })
    .sort({ version: -1 })
    .lean<OrganizationKycSubmission>()
    .exec();
  return latestSubmission?.version || 0;
}

/**
 * Hàm tạo hồ sơ KYC mới cho tổ chức.
 * Mục đích: lưu đầy đủ metadata hồ sơ phiên bản hóa vào MongoDB.
 */
export async function createOrganizationKycSubmission(
  submission: OrganizationKycSubmission
): Promise<OrganizationKycSubmission> {
  const createdSubmission = await OrganizationKycSubmissionModel.create(submission);
  return createdSubmission.toObject() as OrganizationKycSubmission;
}

/**
 * Hàm lấy danh sách hồ sơ KYC theo tổ chức.
 * Mục đích: hiển thị lịch sử nộp hồ sơ để phục vụ audit và truy vết.
 */
export async function findSubmissionsByOrganizationId(
  organizationId: string
): Promise<OrganizationKycSubmission[]> {
  return OrganizationKycSubmissionModel.find({ organizationId })
    .sort({ version: -1 })
    .lean<OrganizationKycSubmission[]>()
    .exec();
}

/**
 * Hàm lấy hồ sơ KYC mới nhất của tổ chức.
 * Mục đích: cung cấp thông tin profile tổ chức gần nhất để hiển thị trên tab cài đặt.
 */
export async function findLatestSubmissionByOrganizationId(organizationId: string): Promise<OrganizationKycSubmission | null> {
  return OrganizationKycSubmissionModel.findOne({ organizationId })
    .sort({ version: -1 })
    .lean<OrganizationKycSubmission>()
    .exec();
}

/**
 * Hàm lấy danh sách hồ sơ KYC chờ duyệt.
 * Mục đích: phục vụ màn hình review cho Regulatory/Admin.
 */
export async function findPendingKycSubmissions(): Promise<OrganizationKycSubmission[]> {
  return OrganizationKycSubmissionModel.find({ status: 'PENDING_REVIEW' })
    .sort({ submittedAt: 1 })
    .lean<OrganizationKycSubmission[]>()
    .exec();
}

/**
 * Hàm đếm tổng số hồ sơ KYC đang chờ duyệt.
 * Mục đích: trả metric tổng quan hệ thống cho trang admin mà không cần dùng mock data.
 */
export async function countPendingKycSubmissions(): Promise<number> {
  return OrganizationKycSubmissionModel.countDocuments({ status: 'PENDING_REVIEW' }).exec();
}

/**
 * Hàm tìm hồ sơ KYC theo submissionId.
 * Mục đích: lấy đúng bản ghi để xử lý phê duyệt hoặc từ chối.
 */
export async function findSubmissionBySubmissionId(submissionId: string): Promise<OrganizationKycSubmission | null> {
  return OrganizationKycSubmissionModel.findOne({ submissionId }).lean<OrganizationKycSubmission>().exec();
}

/**
 * Hàm tìm tổ chức đã liên kết với cặp số tài khoản và tên ngân hàng nhất định (ngoại trừ tổ chức hiện tại).
 * Mục đích: kiểm tra ràng buộc "mỗi tài khoản ngân hàng chỉ được liên kết duy nhất với một tổ chức" trước khi cho phép nộp hồ sơ.
 * Chỉ trả về bản ghi có status APPROVED hoặc PENDING_REVIEW — bản ghi bị REJECTED thì tài khoản được phép tái sử dụng.
 */
export async function findExistingBankAccountOwner(
  bankAccountNumber: string,
  bankName: string,
  excludeOrganizationId: string
): Promise<{ organizationId: string; organizationName: string; status: OrganizationKycSubmission['status'] } | null> {
  const normalizedAccountNumber = bankAccountNumber.trim();
  const normalizedBankName = bankName.trim();
  const existingSubmission = await OrganizationKycSubmissionModel.findOne({
    'beneficiaryBankAccount.bankAccountNumber': normalizedAccountNumber,
    'beneficiaryBankAccount.bankName': normalizedBankName,
    organizationId: { $ne: excludeOrganizationId },
    status: { $in: ['APPROVED', 'PENDING_REVIEW'] }
  })
    .lean<{ organizationId: string; organizationName: string; status: string }>()
    .exec();

  if (!existingSubmission) {
    return null;
  }

  return {
    organizationId: existingSubmission.organizationId,
    organizationName: existingSubmission.organizationName,
    status: existingSubmission.status as OrganizationKycSubmission['status']
  };
}

/**
 * Hàm cập nhật kết quả review hồ sơ KYC.
 * Mục đích: lưu trạng thái duyệt cuối cùng và metadata reviewer.
 */
export async function updateOrganizationKycSubmissionReview(
  submissionId: string,
  reviewData: {
    status: OrganizationKycSubmission['status'];
    reviewedBy: string | null;
    reviewedAt: Date | null;
    rejectionReason: string | null;
    files: OrganizationKycFile[];
  }
): Promise<OrganizationKycSubmission | null> {
  const updatedSubmission = await OrganizationKycSubmissionModel.findOneAndUpdate(
    { submissionId },
    {
      status: reviewData.status,
      reviewedBy: reviewData.reviewedBy,
      reviewedAt: reviewData.reviewedAt,
      rejectionReason: reviewData.rejectionReason,
      files: reviewData.files
    },
    { returnDocument: 'after' }
  ).exec();

  return updatedSubmission ? (updatedSubmission.toObject() as OrganizationKycSubmission) : null;
}
