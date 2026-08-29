import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ProgressBar, SectionCard, StatusBadge } from './OrganizationUiParts';
import { transparencyTransactionRows } from './mockData';
import { ApiErrorDetail, ApiErrorResponse, fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import IpfsEvidencePreviewCard from '@/app/components/common/IpfsEvidencePreviewCard';
import { EvidenceCameraCapture } from '@/app/components/common/evidenceCamera/EvidenceCameraCapture';
import type { CapturedEvidencePhoto } from '@/app/components/common/evidenceCamera/types';
import { DashboardDonationHistoryItem, DashboardFeaturedProject, ProjectSummary, StatisticItem, TimelineItem } from './types';

type DisbursementSectionProps = {
  activeDisbursementTab: 'eligible' | 'pending' | 'history';
  onChangeDisbursementTab: (tab: 'eligible' | 'pending' | 'history') => void;
  disbursements?: import('./types').DisbursementResult[];
  isDisbursementsLoading?: boolean;
  disbursementsErrorMessage?: string | null;
  onRetryLoadDisbursements?: () => void;
  createdProjects?: import('./types').ProjectSummary[];
  raisedAmountByProjectIdMap?: Map<string, number>;
  onOpenCreateDisbursementModal?: (project: import('./types').ProjectSummary) => void;
};

type CreateDisbursementModalProps = {
  project: ProjectSummary;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string | null;
  };
  onClose: () => void;
  onCreated: (disbursement: import('./types').DisbursementResult) => void;
};

type CreateProjectModalProps = {
  onClose: () => void;
  onProjectCreated: (project: ProjectSummary) => void;
};

type ProjectsSectionProps = {
  createdProjects: ProjectSummary[];
  raisedAmountByProjectIdMap?: Map<string, number>;
  isProjectsLoading?: boolean;
  projectsErrorMessage?: string | null;
  onRetryLoadProjects?: () => void;
  onOpenCreateProjectModal: () => void;
  isCreateProjectAllowed?: boolean;
  createProjectBlockReason?: string | null;
  onGoToBankSettings?: () => void;
  onProjectSubmitted: (projectId: string, project: ProjectSummary) => void;
  onProjectUpdated: (projectId: string, project: ProjectSummary) => void;
};

const donationHistoryPageSizeOptionList = [8, 16, 24] as const;

type DashboardSectionProps = {
  onLinkBankAccount: () => void;
  hasApprovedBeneficiaryBankAccount: boolean;
  statisticItemList: StatisticItem[];
  dashboardTimelineItemList: TimelineItem[];
  dashboardDonationHistoryItemList?: DashboardDonationHistoryItem[];
  featuredProject: DashboardFeaturedProject | null;
  isDashboardLoading: boolean;
  isDonationHistoryLoading?: boolean;
  dashboardErrorMessage: string | null;
  donationHistoryErrorMessage?: string | null;
  onRetryLoadDashboardData: () => void;
  onRetryLoadDonationHistory?: () => void;
};

type ProjectCardView = {
  key: string;
  projectId: string | null;
  projectStatus: ProjectSummary['status'];
  emoji: string;
  thumbStyle: string;
  statusLabel: string;
  statusStyle: string;
  name: string;
  description: string;
  progressLabel: string;
  progressPercent: number;
  raisedAmount: string;
  goalAmount: string;
  footerMeta: string[];
  statusKey: 'active' | 'pending' | 'done';
  canSubmitForApproval: boolean;
  hasGeofence: boolean;
  canUpdateProject: boolean;
};

type CreateProjectFormData = {
  name: string;
  description: string;
  goalAmount: string;
  deadline: string;
  milestonePlan: Array<{ percentage: string; description: string }>;
};

type CreateProjectFormErrors = Partial<Record<keyof CreateProjectFormData | 'evidenceFiles', string>>;

type UpdateProjectFormData = {
  name: string;
  description: string;
  goalAmount: string;
  deadline: string;
};

type UpdateProjectFormErrors = Partial<Record<keyof UpdateProjectFormData | 'evidenceFiles', string>>;

/** Hàm đổi ISO date sang định dạng input datetime-local. Mục đích: đổ dữ liệu deadline hiện tại vào form cập nhật. */
function formatDateTimeLocalValue(dateIsoString: string): string {
  const parsedDate = new Date(dateIsoString);
  if (Number.isNaN(parsedDate.getTime())) {
    return '';
  }

  const timezoneOffsetInMilliseconds = parsedDate.getTimezoneOffset() * 60 * 1000;
  const localDate = new Date(parsedDate.getTime() - timezoneOffsetInMilliseconds);
  return localDate.toISOString().slice(0, 16);
}

type UploadEvidenceFilePayload = {
  fileName: string;
  mimeType: string;
  contentBase64: string;
};

type UploadEvidenceResponse = {
  evidenceCids: string[];
  evidenceFiles: { cid: string; fileName: string; mimeType: string }[];
};

type MaxWithdrawableResponse = {
  projectId: string;
  maxAmount: string;
  reserve: string;
};

type CreateDisbursementFormData = {
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string;
  amount: string;
  usagePurpose: string;
};

type CreateDisbursementFormErrors = Partial<Record<keyof CreateDisbursementFormData | 'evidencePhotos', string>>;

const createProjectDefaultFormState: CreateProjectFormData = {
  name: '',
  description: '',
  goalAmount: '',
  deadline: '',
  milestonePlan: [
    { percentage: '', description: '' },
    { percentage: '', description: '' },
    { percentage: '', description: '' }
  ]
};

const createDisbursementDefaultFormState: CreateDisbursementFormData = {
  requestMode: 'NORMAL',
  emergencyReason: '',
  amount: '',
  usagePurpose: ''
};
const minimumPayosTransferAmountVnd = 10000;
const TOTAL_MILESTONE_ERROR_MESSAGE = 'Tổng phân bổ cần đạt 100%.';

const createdProjectEmojis = ['🚀', '📌', '🎯', '✨', '🌱'];
const createdProjectStyles = [
  'bg-gradient-to-br from-[#E0F2FE] to-[#BAE6FD]',
  'bg-gradient-to-br from-[#DCFCE7] to-[#BBF7D0]',
  'bg-gradient-to-br from-[#FCE7F3] to-[#FBCFE8]',
  'bg-gradient-to-br from-[#FEF3C7] to-[#FDE68A]',
  'bg-gradient-to-br from-[#EDE9FE] to-[#DDD6FE]'
];
/** Hàm chuyển file thành base64. Mục đích: chuẩn hóa dữ liệu file upload trước khi gửi backend xử lý IPFS/Pinata. */
async function convertFileToBase64(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binaryContent = '';

  // Logic này dùng vòng lặp tường minh để tránh lỗi stack khi file lớn nếu dùng String.fromCharCode với spread.
  uint8Array.forEach(byteValue => {
    binaryContent += String.fromCharCode(byteValue);
  });

  return window.btoa(binaryContent);
}

/** Hàm định dạng tiền theo chuẩn VNĐ. Mục đích: hiển thị số tiền rõ ràng cho người dùng. */
function formatCurrencyFromNumber(amount: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(amount);
}

/** Hàm lấy nhãn trạng thái dự án. Mục đích: thống nhất màu và nhãn theo status backend. */
function buildStatusPresentation(status: ProjectSummary['status']): {
  statusLabel: string;
  statusStyle: string;
  statusKey: 'active' | 'pending' | 'done';
} {
  if (status === 'ACTIVE') {
    return { statusLabel: '● ĐANG HOẠT ĐỘNG', statusStyle: 'bg-[#DCFCE7] text-[#166534]', statusKey: 'active' };
  }

  if (status === 'COMPLETED') {
    return { statusLabel: '● HOÀN THÀNH', statusStyle: 'bg-[#E5E7EB] text-[#374151]', statusKey: 'done' };
  }

  if (status === 'CLOSED') {
    return { statusLabel: '● ĐÃ ĐÓNG', statusStyle: 'bg-[#E5E7EB] text-[#374151]', statusKey: 'done' };
  }

  if (status === 'REJECTED') {
    return { statusLabel: '● BỊ TỪ CHỐI', statusStyle: 'bg-[#FEE2E2] text-[#991B1B]', statusKey: 'pending' };
  }

  if (status === 'PENDING_ACTIVATION') {
    return { statusLabel: '● ĐANG NIÊM YẾT', statusStyle: 'bg-[#EDE9FE] text-[#6D28D9]', statusKey: 'pending' };
  }

  if (status === 'DISPUTED') {
    return { statusLabel: '● ĐANG TRANH CHẤP', statusStyle: 'bg-[#FEE2E2] text-[#991B1B]', statusKey: 'pending' };
  }

  if (status === 'DRAFT') {
    return { statusLabel: '● BẢN NHÁP', statusStyle: 'bg-[#E0F2FE] text-[#0C4A6E]', statusKey: 'pending' };
  }

  return { statusLabel: '● CHỜ PHÊ DUYỆT', statusStyle: 'bg-[#FEF3C7] text-[#92400E]', statusKey: 'pending' };
}

/** Hàm chuyển dữ liệu dự án vừa tạo sang dạng card hiển thị. Mục đích: đồng bộ layout UI với dữ liệu API. */
function mapCreatedProjectToCardView(
  project: ProjectSummary,
  index: number,
  raisedAmountByProjectIdMap: Map<string, number>
): ProjectCardView {
  const statusPresentation = buildStatusPresentation(project.status);
  const deadlineDate = new Date(project.deadline);
  const raisedAmountValue = raisedAmountByProjectIdMap.get(project.projectId) || 0;
  const progressPercent =
    project.goalAmount > 0
      ? Math.min(100, Math.round((raisedAmountValue / project.goalAmount) * 100))
      : 0;

  // Logic này tính số ngày còn lại để hiển thị nhanh tình trạng deadline trong footer của card.
  const remainingDays = Math.max(0, Math.ceil((deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  const remainingLabel = remainingDays > 0 ? `📅 ${remainingDays} ngày` : '📅 Hết hạn';
  const activationRemainingHours = project.activationEligibleAt ? Math.max(0, Math.ceil((new Date(project.activationEligibleAt).getTime() - Date.now()) / (1000 * 60 * 60))) : null;
  const activationListingLabel = project.status === 'PENDING_ACTIVATION'
    ? activationRemainingHours && activationRemainingHours > 0
      ? `⏳ Niêm yết: còn ${activationRemainingHours} giờ`
      : '⏳ Đang chờ kích hoạt tự động'
    : null;

  return {
    key: project.projectId,
    projectId: project.projectId,
    projectStatus: project.status,
    emoji: createdProjectEmojis[index % createdProjectEmojis.length],
    thumbStyle: createdProjectStyles[index % createdProjectStyles.length],
    statusLabel: statusPresentation.statusLabel,
    statusStyle: statusPresentation.statusStyle,
    name: project.name,
    description: project.description,
    progressLabel: `${progressPercent}%`,
    progressPercent,
    raisedAmount: `${formatCurrencyFromNumber(raisedAmountValue)} ₫`,
    goalAmount: `${formatCurrencyFromNumber(project.goalAmount)} ₫`,
    footerMeta: ['👥 0', remainingLabel, ...(activationListingLabel ? [activationListingLabel] : []), '🏅 Chờ xếp hạng'],
    statusKey: statusPresentation.statusKey,
    canSubmitForApproval: project.status === 'DRAFT',
    hasGeofence: project.hasGeofence ?? false,
    canUpdateProject: project.status === 'PENDING_APPROVAL'
  };
}

/** Hàm đổi trạng thái dự án sang tiếng Việt. Mục đích: hiển thị thông tin trạng thái dễ hiểu trong modal chi tiết. */
function formatProjectStatusVietnamese(status: ProjectSummary['status']): string {
  if (status === 'DRAFT') {
    return 'Bản nháp';
  }

  if (status === 'PENDING_APPROVAL') {
    return 'Chờ phê duyệt';
  }

  if (status === 'PENDING_ACTIVATION') {
    return 'Đang niêm yết công khai';
  }

  if (status === 'DISPUTED') {
    return 'Đang tranh chấp';
  }

  if (status === 'ACTIVE') {
    return 'Đang hoạt động';
  }

  if (status === 'COMPLETED') {
    return 'Hoàn thành';
  }

  if (status === 'CLOSED') {
    return 'Đã đóng';
  }

  return 'Bị từ chối';
}

/** Hàm đổi trạng thái giải ngân sang tiếng Việt. Mục đích: hiển thị trạng thái yêu cầu giải ngân đúng ngữ cảnh nghiệp vụ cho tổ chức. */
function formatDisbursementStatusVietnamese(disbursement: import('./types').DisbursementResult): string {
  if (disbursement.payosTransferStatus === 'MANUAL_REVIEW') {
    return 'Cần kiểm tra thủ công';
  }

  if (disbursement.payosTransferStatus === 'FAILED') {
    return 'Chuyển khoản thất bại';
  }

  if (disbursement.payosTransferStatus === 'PROCESSING') {
    return 'Đang chuyển khoản';
  }

  const status = disbursement.status;
  if (status === 'PENDING') {
    return 'Chờ duyệt';
  }

  if (status === 'APPROVED') {
    return 'Đã duyệt';
  }

  if (status === 'EXECUTING') {
    return 'Đang chuyển khoản';
  }

  if (status === 'COMPLETED') {
    return 'Hoàn tất';
  }

  if (status === 'REJECTED') {
    return 'Bị từ chối';
  }

  if (status === 'EXPIRED') {
    return 'Hết hạn';
  }

  return 'Đã hủy';
}

/** Hàm chọn màu thẻ trạng thái giải ngân. Mục đích: giúp lịch sử yêu cầu giải ngân dễ quét và nhận diện trạng thái nhanh hơn. */
function getDisbursementStatusBadgeClassName(disbursement: import('./types').DisbursementResult): string {
  if (disbursement.payosTransferStatus === 'SUCCESS' || disbursement.status === 'COMPLETED') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }

  if (disbursement.payosTransferStatus === 'FAILED' || disbursement.status === 'REJECTED' || disbursement.status === 'CANCELLED' || disbursement.status === 'EXPIRED') {
    return 'border-rose-200 bg-rose-50 text-rose-700';
  }

  if (disbursement.payosTransferStatus === 'MANUAL_REVIEW' || disbursement.status === 'APPROVED') {
    return 'border-sky-200 bg-sky-50 text-sky-700';
  }

  if (disbursement.payosTransferStatus === 'PROCESSING' || disbursement.status === 'EXECUTING') {
    return 'border-blue-200 bg-blue-50 text-blue-700';
  }

  return 'border-amber-200 bg-amber-50 text-amber-700';
}

/** Hàm định dạng thời gian hiển thị tiếng Việt. Mục đích: hiển thị timestamp dự án dễ đọc trong modal chi tiết. */
function formatDateTimeVietnamese(dateValue: string | null): string {
  if (!dateValue) {
    return 'Chưa có';
  }

  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Không hợp lệ';
  }

  return parsedDate.toLocaleString('vi-VN');
}

type ActiveSessionItem = {
  sessionId: string;
  deviceLabel: string;
  ipAddress: string;
  loggedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
};

type OrganizationProfileItem = {
  organizationName: string;
  legalRegistrationNumber: string;
  officialWebsite: string | null;
  organizationDescription: string | null;
};

/** Hàm định dạng thời điểm phiên cho tab bảo mật. Mục đích: hiển thị thời gian dễ đọc theo chuẩn tiếng Việt. */
function formatSecurityDateTime(dateValue: string): string {
  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Không hợp lệ';
  }

  return parsedDate.toLocaleString('vi-VN');
}

/** Hàm chuẩn hóa thông báo lỗi khi tải phiên đăng nhập. Mục đích: hiển thị lỗi thân thiện và đúng ngữ cảnh bảo mật. */
function resolveSecuritySessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'Không thể tải dữ liệu phiên đăng nhập. Vui lòng thử lại.';
  }

  const typedError = error as ApiErrorResponse;
  if (typedError.statusCode === 401 || typedError.errorCode === 'UNAUTHENTICATED') {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }

  if (typedError.statusCode === 429 || typedError.errorCode === 'RATE_LIMIT_EXCEEDED') {
    return 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.';
  }

  return typedError.message || 'Không thể tải dữ liệu phiên đăng nhập. Vui lòng thử lại.';
}

/** Hàm chuẩn hóa thông báo lỗi khi tải profile tổ chức. Mục đích: hiển thị lỗi thân thiện và đúng ngữ cảnh tab tổ chức. */
function resolveOrganizationProfileErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'Không thể tải thông tin tổ chức. Vui lòng thử lại.';
  }

  const typedError = error as ApiErrorResponse;
  if (typedError.statusCode === 401 || typedError.errorCode === 'UNAUTHENTICATED') {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }

  if (typedError.statusCode === 429 || typedError.errorCode === 'RATE_LIMIT_EXCEEDED') {
    return 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.';
  }

  return typedError.message || 'Không thể tải thông tin tổ chức. Vui lòng thử lại.';
}

/** Phân tích trạng thái kế hoạch cột mốc để chỉ hiển thị phản hồi cần thiết theo dữ liệu người dùng đã nhập. */
function buildMilestonePlanFeedback(formData: CreateProjectFormData): {
  totalPercentage: number;
  hasInput: boolean;
  validationMessage: string | null;
} {
  const milestonePlan = formData.milestonePlan;
  const hasInput = milestonePlan.some(item => item.percentage.trim().length > 0 || item.description.trim().length > 0);
  const percentages = milestonePlan.map(item => Number(item.percentage));
  const totalPercentage = percentages.reduce((total, percentage) => total + (Number.isFinite(percentage) ? percentage : 0), 0);

  if (milestonePlan.length !== 3) {
    return { totalPercentage, hasInput, validationMessage: 'Kế hoạch cần có đúng 3 mốc.' };
  }

  if (!hasInput || milestonePlan.some(item => item.percentage.trim().length === 0)) {
    return { totalPercentage, hasInput, validationMessage: 'Nhập tỷ lệ cho đủ 3 mốc.' };
  }

  if (percentages[0] > 25) {
    return { totalPercentage, hasInput, validationMessage: 'Mốc M1 không được vượt quá 25%.' };
  }

  if (percentages.some(percentage => !Number.isInteger(percentage) || percentage <= 0)) {
    return { totalPercentage, hasInput, validationMessage: 'Tỷ lệ mỗi mốc phải là số nguyên dương.' };
  }

  if (milestonePlan.some(item => item.description.trim().length === 0)) {
    return { totalPercentage, hasInput, validationMessage: 'Thêm mô tả cho đủ 3 mốc.' };
  }

  if (milestonePlan.some(item => item.description.trim().length < 10 || item.description.trim().length > 500)) {
    return { totalPercentage, hasInput, validationMessage: 'Mỗi mô tả cần từ 10–500 ký tự.' };
  }

  return { totalPercentage, hasInput, validationMessage: null };
}

/** Hàm validate form tạo dự án phía client. Mục đích: phản hồi lỗi sớm trước khi gửi request lên server. */
function validateCreateProjectFormData(formData: CreateProjectFormData, selectedEvidenceFiles: File[]): CreateProjectFormErrors {
  const formErrors: CreateProjectFormErrors = {};

  if (formData.name.trim().length < 3 || formData.name.trim().length > 120) {
    formErrors.name = 'Tên dự án phải từ 3 đến 120 ký tự.';
  }

  if (formData.description.trim().length < 10 || formData.description.trim().length > 2000) {
    formErrors.description = 'Mô tả dự án phải từ 10 đến 2000 ký tự.';
  }

  const parsedGoalAmount = Number(formData.goalAmount);
  if (!Number.isFinite(parsedGoalAmount) || parsedGoalAmount <= 0) {
    formErrors.goalAmount = 'Mục tiêu gây quỹ phải lớn hơn 0.';
  }

  if (!formData.deadline) {
    formErrors.deadline = 'Vui lòng chọn thời hạn dự án.';
  } else {
    const parsedDeadline = new Date(formData.deadline);
    if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) {
      formErrors.deadline = 'Hạn dự án phải là thời gian trong tương lai.';
    }
  }

  if (selectedEvidenceFiles.length === 0) {
    formErrors.evidenceFiles = 'Vui lòng tải lên ít nhất 3 file minh chứng.';
  }

  if (selectedEvidenceFiles.length > 0 && selectedEvidenceFiles.length < 3) {
    formErrors.evidenceFiles = 'Vui lòng tải lên ít nhất 3 file minh chứng.';
  }

  if (selectedEvidenceFiles.length > 10) {
    formErrors.evidenceFiles = 'Bạn chỉ được tải lên tối đa 10 file minh chứng.';
  }

  const milestonePlanFeedback = buildMilestonePlanFeedback(formData);
  if (milestonePlanFeedback.validationMessage) {
    formErrors.milestonePlan = milestonePlanFeedback.validationMessage;
  }

  if (milestonePlanFeedback.totalPercentage !== 100 && !formErrors.milestonePlan) {
    formErrors.milestonePlan = TOTAL_MILESTONE_ERROR_MESSAGE;
  }

  return formErrors;
}

/** Hàm map lỗi API về lỗi theo field. Mục đích: hiển thị lỗi đúng vị trí input trong modal tạo dự án. */
function mapApiDetailsToFormErrors(details: ApiErrorDetail[]): CreateProjectFormErrors {
  const formErrors: CreateProjectFormErrors = {};

  details.forEach(detail => {
    if (detail.field === 'name') {
      formErrors.name = detail.message;
    }

    if (detail.field === 'description') {
      formErrors.description = detail.message;
    }

    if (detail.field === 'goalAmount') {
      formErrors.goalAmount = detail.message;
    }

    if (detail.field === 'deadline') {
      formErrors.deadline = detail.message;
    }

    if (detail.field === 'evidenceCids') {
      formErrors.evidenceFiles = detail.message;
    }

    if (detail.field.startsWith('milestonePlan')) {
      formErrors.milestonePlan = detail.message;
    }
  });

  return formErrors;
}

/** Hàm validate form cập nhật dự án phía client. Mục đích: kiểm tra dữ liệu trước khi gọi API cập nhật. */
function validateUpdateProjectFormData(formData: UpdateProjectFormData, selectedEvidenceFiles: File[]): UpdateProjectFormErrors {
  const formErrors: UpdateProjectFormErrors = {};

  if (formData.name.trim().length < 3 || formData.name.trim().length > 120) {
    formErrors.name = 'Tên dự án phải từ 3 đến 120 ký tự.';
  }

  if (formData.description.trim().length < 10 || formData.description.trim().length > 2000) {
    formErrors.description = 'Mô tả dự án phải từ 10 đến 2000 ký tự.';
  }

  const parsedGoalAmount = Number(formData.goalAmount);
  if (!Number.isFinite(parsedGoalAmount) || parsedGoalAmount <= 0) {
    formErrors.goalAmount = 'Mục tiêu gây quỹ phải lớn hơn 0.';
  }

  if (!formData.deadline) {
    formErrors.deadline = 'Vui lòng chọn thời hạn dự án.';
  } else {
    const parsedDeadline = new Date(formData.deadline);
    if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) {
      formErrors.deadline = 'Hạn dự án phải là thời gian trong tương lai.';
    }
  }

  if (selectedEvidenceFiles.length > 10) {
    formErrors.evidenceFiles = 'Bạn chỉ được tải lên tối đa 10 file minh chứng mới.';
  }

  return formErrors;
}

/** Hàm map lỗi API sang lỗi form cập nhật. Mục đích: hiển thị lỗi đúng trường khi API trả validation details. */
function mapApiDetailsToUpdateFormErrors(details: ApiErrorDetail[]): UpdateProjectFormErrors {
  const formErrors: UpdateProjectFormErrors = {};

  details.forEach(detail => {
    if (detail.field === 'name') {
      formErrors.name = detail.message;
    }

    if (detail.field === 'description') {
      formErrors.description = detail.message;
    }

    if (detail.field === 'goalAmount') {
      formErrors.goalAmount = detail.message;
    }

    if (detail.field === 'deadline') {
      formErrors.deadline = detail.message;
    }

    if (detail.field === 'evidenceCids') {
      formErrors.evidenceFiles = detail.message;
    }
  });

  return formErrors;
}

/** Hàm chuẩn hóa thông báo lỗi API. Mục đích: hiển thị đúng lỗi theo status code thay vì luôn rơi vào thông báo rate limit sai ngữ cảnh. */
function resolveApiErrorMessage(error: unknown, fallbackErrorMessage: string): string {
  if (!error || typeof error !== 'object') {
    return fallbackErrorMessage;
  }

  const typedError = error as ApiErrorResponse;
  if (typedError.statusCode === 429 || typedError.errorCode === 'RATE_LIMIT_EXCEEDED') {
    return 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.';
  }

  if (typedError.statusCode === 401 || typedError.errorCode === 'UNAUTHENTICATED') {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }

  // HTTP 409 Conflict: tài khoản ngân hàng đã được liên kết với tổ chức khác.
  // Backend trả về message cụ thể, frontend hiển thị nguyên bản để người dùng rõ nguyên nhân.
  if (typedError.statusCode === 409) {
    return typedError.message || 'Tài khoản ngân hàng này đã được liên kết với tổ chức khác.';
  }

  return typedError.message || fallbackErrorMessage;
}

/** Hàm render section Dashboard. Mục đích: hiển thị cảnh báo, thống kê, biểu đồ mô phỏng và timeline. */
export function DashboardSection({
  onLinkBankAccount,
  hasApprovedBeneficiaryBankAccount,
  statisticItemList,
  dashboardTimelineItemList,
  dashboardDonationHistoryItemList = [],
  featuredProject,
  isDashboardLoading,
  isDonationHistoryLoading = false,
  dashboardErrorMessage,
  donationHistoryErrorMessage = null,
  onRetryLoadDashboardData,
  onRetryLoadDonationHistory = () => undefined
}: DashboardSectionProps) {
  const [selectedDonationHistoryFilter, setSelectedDonationHistoryFilter] = useState<'day' | 'week' | 'month'>('day');
  const [selectedDonationHistoryPageSize, setSelectedDonationHistoryPageSize] = useState<number>(8);
  const [donationHistoryPageByFilter, setDonationHistoryPageByFilter] = useState<Record<'day' | 'week' | 'month', number>>({ day: 1, week: 1, month: 1 });

  const filteredDashboardDonationHistoryItemList = useMemo(() => {
    const nowTimestampValue = Date.now();
    const filterRangeMillisecondsMap: Record<'day' | 'week' | 'month', number> = {
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000
    };
    const minAcceptedTimestampValue = nowTimestampValue - filterRangeMillisecondsMap[selectedDonationHistoryFilter];

    // Logic này ưu tiên timestampIso để lọc chính xác theo mốc thời gian, đồng thời fallback timestamp text để tránh mất dữ liệu cũ.
    return dashboardDonationHistoryItemList.filter(historyItem => {
      const parsedTimestampValue = Date.parse(historyItem.timestampIso || historyItem.timestamp);
      if (Number.isNaN(parsedTimestampValue)) {
        return false;
      }

      return parsedTimestampValue >= minAcceptedTimestampValue;
    });
  }, [dashboardDonationHistoryItemList, selectedDonationHistoryFilter]);

  const donationHistoryCurrentPage = donationHistoryPageByFilter[selectedDonationHistoryFilter];

  const donationHistoryTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredDashboardDonationHistoryItemList.length / selectedDonationHistoryPageSize));
  }, [filteredDashboardDonationHistoryItemList.length, selectedDonationHistoryPageSize]);

  useEffect(() => {
    setDonationHistoryPageByFilter(currentPageByFilter => {
      const currentFilterPage = currentPageByFilter[selectedDonationHistoryFilter];
      if (currentFilterPage <= donationHistoryTotalPages) {
        return currentPageByFilter;
      }

      return {
        ...currentPageByFilter,
        [selectedDonationHistoryFilter]: donationHistoryTotalPages
      };
    });
  }, [donationHistoryTotalPages, selectedDonationHistoryFilter]);

  /** Hàm lấy danh sách lịch sử quyên góp theo trang hiện tại. Mục đích: phân trang riêng cho từng bộ lọc Ngày/Tuần/Tháng. */
  const displayedDashboardDonationHistoryItemList = useMemo(() => {
    const startIndex = (donationHistoryCurrentPage - 1) * selectedDonationHistoryPageSize;
    return filteredDashboardDonationHistoryItemList.slice(startIndex, startIndex + selectedDonationHistoryPageSize);
  }, [donationHistoryCurrentPage, filteredDashboardDonationHistoryItemList, selectedDonationHistoryPageSize]);

  /** Hàm xử lý chọn bộ lọc thời gian lịch sử quyên góp. Mục đích: cập nhật mốc thời gian để danh sách hiển thị theo Ngày/Tuần/Tháng. */
  const handleSelectDonationHistoryFilter = (nextFilter: 'day' | 'week' | 'month') => {
    setSelectedDonationHistoryFilter(nextFilter);
  };

  /** Hàm đổi số dòng mỗi trang lịch sử quyên góp. Mục đích: quay về trang đầu cho từng filter để tránh vượt quá tổng trang mới. */
  const handleChangeDonationHistoryPageSize = (nextPageSize: number) => {
    setSelectedDonationHistoryPageSize(nextPageSize);
    setDonationHistoryPageByFilter({ day: 1, week: 1, month: 1 });
  };

  /** Hàm chuyển trang lịch sử quyên góp. Mục đích: cập nhật trang hiện tại theo đúng filter đang chọn. */
  const handleChangeDonationHistoryPage = (nextPage: number) => {
    setDonationHistoryPageByFilter(currentPageByFilter => ({
      ...currentPageByFilter,
      [selectedDonationHistoryFilter]: Math.min(donationHistoryTotalPages, Math.max(1, nextPage))
    }));
  };

  const donationHistoryEmptyMessage = useMemo(() => {
    if (selectedDonationHistoryFilter === 'day') {
      return 'Chưa có giao dịch quyên góp trong 24 giờ gần nhất.';
    }

    if (selectedDonationHistoryFilter === 'week') {
      return 'Chưa có giao dịch quyên góp trong 7 ngày gần nhất.';
    }

    return 'Chưa có giao dịch quyên góp trong 30 ngày gần nhất.';
  }, [selectedDonationHistoryFilter]);

  return (
    <div className="space-y-6">
      {!hasApprovedBeneficiaryBankAccount ? (
        <div className="flex items-start gap-3 rounded-[14px] border border-[#FED7AA] border-l-4 border-l-[#D97706] bg-gradient-to-r from-[#FFF7ED] to-[#FFFBEB] p-4">
          <span className="text-xl">🏦</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#92400E]">Chưa liên kết tài khoản ngân hàng thụ hưởng</p>
            <p className="text-xs text-[#B45309]">Bạn cần xác lập STK ngân hàng trước khi tạo dự án để đảm bảo minh bạch giải ngân.</p>
          </div>
          <button
            type="button"
            onClick={onLinkBankAccount}
            className="rounded bg-[#D97706] px-3 py-2 text-xs font-semibold text-white"
          >
            Liên kết ngay →
          </button>
        </div>
      ) : null}

      {dashboardErrorMessage ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[#FECACA] bg-[#FEF2F2] px-4 py-3">
          <p className="text-sm text-[#B91C1C]">{dashboardErrorMessage}</p>
          <button
            type="button"
            onClick={onRetryLoadDashboardData}
            className="rounded bg-[#B91C1C] px-3 py-1.5 text-xs font-semibold text-white"
          >
            Tải lại dữ liệu
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {statisticItemList.map(item => (
          <SectionCard key={item.label} title={item.label} bodyClassName="space-y-2 p-4">
            <p className="text-2xl font-bold">{item.icon} {item.value}</p>
            <p className="text-xs text-[#6B7280]">{item.subtitle}</p>
            <StatusBadge label={item.change} className={item.changeStyle === 'warn' ? 'bg-[#FEF3C7] text-[#92400E]' : 'bg-[#DCFCE7] text-[#166534]'} />
          </SectionCard>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
        <SectionCard
          title="Lịch sử quyên góp"
          rightSlot={
            <div className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={() => handleSelectDonationHistoryFilter('day')}
                className={`rounded border px-2 py-1 ${selectedDonationHistoryFilter === 'day' ? 'border-[#0E7C6B] bg-[#0E7C6B] text-white' : 'border-[#E5E7EB]'}`}
              >
                Ngày
              </button>
              <button
                type="button"
                onClick={() => handleSelectDonationHistoryFilter('week')}
                className={`rounded border px-2 py-1 ${selectedDonationHistoryFilter === 'week' ? 'border-[#0E7C6B] bg-[#0E7C6B] text-white' : 'border-[#E5E7EB]'}`}
              >
                Tuần
              </button>
              <button
                type="button"
                onClick={() => handleSelectDonationHistoryFilter('month')}
                className={`rounded border px-2 py-1 ${selectedDonationHistoryFilter === 'month' ? 'border-[#0E7C6B] bg-[#0E7C6B] text-white' : 'border-[#E5E7EB]'}`}
              >
                Tháng
              </button>
            </div>
          }
        >
          {donationHistoryErrorMessage ? (
            <div className="rounded-[10px] border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">
              <p>{donationHistoryErrorMessage}</p>
              <button
                type="button"
                onClick={onRetryLoadDonationHistory}
                className="mt-2 rounded bg-[#B91C1C] px-2.5 py-1 text-[11px] font-semibold text-white"
              >
                Tải lại lịch sử
              </button>
            </div>
          ) : displayedDashboardDonationHistoryItemList.length > 0 ? (
            <div className="space-y-3">
              <div className="space-y-2">
                {displayedDashboardDonationHistoryItemList.map(historyItem => (
                  <div key={historyItem.transactionHash} className="flex items-center justify-between gap-2 rounded-[10px] border border-[#E5E7EB] bg-[#F9FAFB] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold text-[#111827]">{historyItem.projectName}</p>
                      <p className="truncate text-[11px] text-[#6B7280]">{`${historyItem.donorLabel} · ${historyItem.timestamp}`}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[12px] font-semibold text-[#0E7C6B]">{`${formatCurrencyFromNumber(historyItem.amount)} ₫`}</p>
                      <p className="text-[10px] text-[#9CA3AF]">{historyItem.transactionHash}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-[12px] border border-[#99f6e4] bg-gradient-to-br from-white via-[#f7fffd] to-[#ecfdf5] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(126px,auto)_1fr] sm:items-center sm:gap-3">
                    <label htmlFor="donationHistoryPageSizeSelect" className="text-xs font-semibold text-[#0f766e]">
                      Số dòng mỗi trang
                    </label>
                    <select
                      id="donationHistoryPageSizeSelect"
                      value={selectedDonationHistoryPageSize}
                      onChange={event => handleChangeDonationHistoryPageSize(Number(event.target.value))}
                      disabled={isDonationHistoryLoading}
                      className="h-10 w-full rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-3 text-xs font-semibold text-[#0f766e] outline-none transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8] sm:min-w-[112px]"
                    >
                      {donationHistoryPageSizeOptionList.map(pageSizeOption => (
                        <option key={pageSizeOption} value={pageSizeOption}>
                          {pageSizeOption}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(108px,auto)_1fr_minmax(108px,auto)] sm:items-center sm:gap-2">
                    <button
                      type="button"
                      onClick={() => handleChangeDonationHistoryPage(donationHistoryCurrentPage - 1)}
                      disabled={donationHistoryCurrentPage <= 1 || isDonationHistoryLoading}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-3 text-xs font-semibold text-[#0f766e] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                    >
                      <span aria-hidden="true">←</span>
                      <span>Trang trước</span>
                    </button>

                    {/* Ghi chú logic UI: aria-live giúp trình đọc màn hình nhận biết trang lịch sử đã thay đổi mà không cần tải lại toàn bộ trang. */}
                    <div aria-live="polite" className="flex h-10 items-center justify-center rounded-xl border border-[#99f6e4] bg-[#ecfeff] px-3 text-center text-xs font-semibold text-[#0f766e] sm:min-w-[150px]">
                      <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${isDonationHistoryLoading ? 'animate-pulse bg-[#0d9488]' : 'bg-[#10b981]'}`} />
                      {isDonationHistoryLoading ? 'Đang tải...' : `Trang ${donationHistoryCurrentPage} / ${donationHistoryTotalPages}`}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleChangeDonationHistoryPage(donationHistoryCurrentPage + 1)}
                      disabled={donationHistoryCurrentPage >= donationHistoryTotalPages || isDonationHistoryLoading}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-3 text-xs font-semibold text-[#0f766e] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                    >
                      <span>Trang sau</span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-[10px] border border-dashed border-[#D1D5DB] bg-[#F8FAFB] p-3 text-xs text-[#6B7280]">
              {isDonationHistoryLoading ? 'Đang tải lịch sử quyên góp thực tế...' : donationHistoryEmptyMessage}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Dự án nổi bật">
          {featuredProject ? (
            <>
              <div className="mb-3 flex h-[130px] items-center justify-center rounded-[10px] bg-gradient-to-br from-[#E6F7F4] to-[#BAE6FD] text-4xl">📚</div>
              <p className="font-semibold">{featuredProject.name}</p>
              <p className="mt-1 text-xs text-[#6B7280]">{featuredProject.description}</p>
              <ProgressBar progressPercent={featuredProject.progressPercent} className="mt-3 h-[7px] rounded bg-[#F3F4F6]" />
              <div className="mt-1 flex justify-between text-[11px] text-[#6B7280]">
                <span>{`${formatCurrencyFromNumber(featuredProject.raisedAmount)} ₫`}</span>
                <span>{`${formatCurrencyFromNumber(featuredProject.goalAmount)} ₫`}</span>
              </div>
            </>
          ) : (
            <div className="rounded-[10px] border border-dashed border-[#D1D5DB] bg-[#F8FAFB] p-4 text-xs text-[#6B7280]">
              Chưa có dự án nào để hiển thị nổi bật.
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Hoạt động gần đây" actionText="Xem tất cả">
        {dashboardTimelineItemList.length > 0 ? (
          <div className="space-y-3">
            {dashboardTimelineItemList.map(item => (
              <div key={`${item.content}-${item.time}`} className="flex gap-3 border-b border-[#F3F4F6] pb-2 last:border-none">
                <span className={`mt-1 h-2.5 w-2.5 rounded-full ${item.dotStyle}`} />
                <p className="flex-1 text-sm">{item.content}</p>
                <span className="text-xs text-[#9CA3AF]">{item.time}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[#6B7280]">
            {isDashboardLoading ? 'Đang tải hoạt động gần đây...' : 'Chưa có hoạt động nào để hiển thị.'}
          </p>
        )}
      </SectionCard>
    </div>
  );
}

/** Hàm render section Projects. Mục đích: hiển thị danh sách dự án và cho phép submit dự án chờ duyệt. */
export function ProjectsSection({
  createdProjects,
  raisedAmountByProjectIdMap = new Map<string, number>(),
  isProjectsLoading = false,
  projectsErrorMessage = null,
  onRetryLoadProjects,
  onOpenCreateProjectModal,
  isCreateProjectAllowed = true,
  createProjectBlockReason = null,
  onGoToBankSettings,
  onProjectSubmitted,
  onProjectUpdated
}: ProjectsSectionProps) {
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'active' | 'pending'>('all');
  const [submittingProjectId, setSubmittingProjectId] = useState<string | null>(null);
  const [submitProjectErrorMessage, setSubmitProjectErrorMessage] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isUpdateModalVisible, setIsUpdateModalVisible] = useState(false);
  const [updateFormData, setUpdateFormData] = useState<UpdateProjectFormData>({ name: '', description: '', goalAmount: '', deadline: '' });
  const [updateFormErrors, setUpdateFormErrors] = useState<UpdateProjectFormErrors>({});
  const [selectedUpdateEvidenceFiles, setSelectedUpdateEvidenceFiles] = useState<File[]>([]);
  const [isUpdatingProject, setIsUpdatingProject] = useState(false);
  const [updateProjectErrorMessage, setUpdateProjectErrorMessage] = useState<string | null>(null);

  const mappedCreatedProjects = useMemo(
    () => createdProjects.map((project, projectIndex) => mapCreatedProjectToCardView(project, projectIndex, raisedAmountByProjectIdMap)),
    [createdProjects, raisedAmountByProjectIdMap]
  );

  const mergedProjects = mappedCreatedProjects;

  /** Hàm submit dự án lên reviewer. Mục đích: gọi API submit và cập nhật trạng thái card ngay sau khi thành công. */
  const handleSubmitProjectForApproval = async (project: ProjectCardView) => {
    if (!project.projectId || !project.canSubmitForApproval) {
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setSubmitProjectErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setSubmitProjectErrorMessage(null);
    setSubmittingProjectId(project.projectId);

    try {
      const response = await fetchApi<ProjectSummary>(buildApiUrl('/projects/submit'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({ projectId: project.projectId })
      });

      onProjectSubmitted(project.projectId, response.data);
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể submit dự án. Vui lòng thử lại sau.';
      setSubmitProjectErrorMessage(resolveApiErrorMessage(error, fallbackErrorMessage));
    } finally {
      setSubmittingProjectId(null);
    }
  };

  const filteredProjects = useMemo(() => {
    const normalizedKeyword = searchKeyword.trim().toLowerCase();

    return mergedProjects.filter(project => {
      if (normalizedKeyword && !project.name.toLowerCase().includes(normalizedKeyword)) {
        return false;
      }

      if (selectedFilter === 'active') {
        return project.statusKey === 'active';
      }

      if (selectedFilter === 'pending') {
        return project.statusKey === 'pending';
      }

      return true;
    });
  }, [mergedProjects, searchKeyword, selectedFilter]);

  const selectedProjectDetail = useMemo(
    () => createdProjects.find(projectItem => projectItem.projectId === selectedProjectId) ?? null,
    [createdProjects, selectedProjectId]
  );

  /** Hàm mở modal chi tiết dự án. Mục đích: cho phép người dùng xem đầy đủ thông tin của dự án đã chọn. */
  const handleOpenProjectDetail = (projectId: string | null) => {
    if (!projectId) {
      return;
    }

    setSelectedProjectId(projectId);
    setIsUpdateModalVisible(false);
  };

  /** Hàm mở modal cập nhật dự án. Mục đích: nạp dữ liệu hiện tại vào form trước khi người dùng chỉnh sửa. */
  const handleOpenProjectUpdate = (projectId: string | null) => {
    if (!projectId) {
      return;
    }

    const selectedProject = createdProjects.find(projectItem => projectItem.projectId === projectId);
    if (!selectedProject) {
      return;
    }

    setSelectedProjectId(projectId);
    setIsUpdateModalVisible(true);
    setUpdateProjectErrorMessage(null);
    setSelectedUpdateEvidenceFiles([]);
    setUpdateFormErrors({});
    setUpdateFormData({
      name: selectedProject.name,
      description: selectedProject.description,
      goalAmount: String(selectedProject.goalAmount),
      deadline: formatDateTimeLocalValue(selectedProject.deadline)
    });
  };

  /** Hàm đóng modal chi tiết/cập nhật. Mục đích: reset trạng thái modal sau khi người dùng hoàn tất thao tác. */
  const handleCloseProjectDetailModal = () => {
    setSelectedProjectId(null);
    setIsUpdateModalVisible(false);
    setUpdateProjectErrorMessage(null);
    setSelectedUpdateEvidenceFiles([]);
    setUpdateFormErrors({});
  };

  /** Hàm cập nhật input form sửa dự án. Mục đích: đồng bộ dữ liệu mới và xóa lỗi theo từng trường. */
  const handleChangeUpdateFormField = (field: keyof UpdateProjectFormData, value: string) => {
    const nextFormData: UpdateProjectFormData = { ...updateFormData, [field]: value };
    setUpdateFormData(nextFormData);
    const nextFormErrors = validateUpdateProjectFormData(nextFormData, selectedUpdateEvidenceFiles);
    setUpdateFormErrors(currentErrors => ({ ...currentErrors, [field]: nextFormErrors[field] }));
  };

  /** Hàm chọn file minh chứng mới khi cập nhật. Mục đích: cho phép thay thế một phần hoặc toàn bộ CID cũ. */
  const handleSelectUpdateEvidenceFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) {
      return;
    }

    const nextSelectedEvidenceFiles = [...selectedUpdateEvidenceFiles, ...selectedFiles].slice(0, 10);
    setSelectedUpdateEvidenceFiles(nextSelectedEvidenceFiles);
    setUpdateFormErrors(currentErrors => ({
      ...currentErrors,
      evidenceFiles: validateUpdateProjectFormData(updateFormData, nextSelectedEvidenceFiles).evidenceFiles
    }));
    event.target.value = '';
  };

  /** Hàm xóa file minh chứng mới đã chọn. Mục đích: cho phép người dùng chỉnh lại danh sách file sẽ thay thế. */
  const handleRemoveUpdateEvidenceFile = (fileIndex: number) => {
    const nextSelectedEvidenceFiles = selectedUpdateEvidenceFiles.filter((_, currentFileIndex) => currentFileIndex !== fileIndex);
    setSelectedUpdateEvidenceFiles(nextSelectedEvidenceFiles);
    setUpdateFormErrors(currentErrors => ({
      ...currentErrors,
      evidenceFiles: validateUpdateProjectFormData(updateFormData, nextSelectedEvidenceFiles).evidenceFiles
    }));
  };

  /** Hàm upload file minh chứng mới khi cập nhật. Mục đích: nhận CID mới trước khi gọi API cập nhật dự án. */
  const uploadUpdateEvidenceFiles = async (accessToken: string): Promise<UploadEvidenceResponse> => {
    const uploadPayloadFiles: UploadEvidenceFilePayload[] = await Promise.all(
      selectedUpdateEvidenceFiles.map(async fileItem => ({
        fileName: fileItem.name,
        mimeType: fileItem.type,
        contentBase64: await convertFileToBase64(fileItem)
      }))
    );

    const uploadResponse = await fetchApi<UploadEvidenceResponse>(buildApiUrl('/projects/evidences/upload'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ files: uploadPayloadFiles })
    });

    return uploadResponse.data;
  };

  /** Hàm submit cập nhật dự án. Mục đích: gọi API PATCH và đồng bộ lại card sau khi thành công. */
  const handleSubmitUpdateProject = async (event: { preventDefault: () => void }) => {
    event.preventDefault();

    if (!selectedProjectDetail) {
      setUpdateProjectErrorMessage('Không tìm thấy dữ liệu dự án để cập nhật.');
      return;
    }

    const nextFormErrors = validateUpdateProjectFormData(updateFormData, selectedUpdateEvidenceFiles);
    if (Object.keys(nextFormErrors).length > 0) {
      setUpdateFormErrors(nextFormErrors);
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setUpdateProjectErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setUpdateProjectErrorMessage(null);
    setIsUpdatingProject(true);

    try {
      let nextEvidenceCids = selectedProjectDetail.evidenceCids;
      let nextEvidenceFiles = selectedProjectDetail.evidenceFiles ?? [];

      // Logic này chỉ thay CID khi người dùng thực sự upload file mới; nếu không thì giữ nguyên CID cũ.
      if (selectedUpdateEvidenceFiles.length > 0) {
        const uploadResult = await uploadUpdateEvidenceFiles(authSession.accessToken);
        nextEvidenceCids = uploadResult.evidenceCids;
        nextEvidenceFiles = uploadResult.evidenceFiles;
      }

      const response = await fetchApi<ProjectSummary>(buildApiUrl('/projects'), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({
          projectId: selectedProjectDetail.projectId,
          name: updateFormData.name.trim(),
          description: updateFormData.description.trim(),
          goalAmount: Number(updateFormData.goalAmount),
          deadline: new Date(updateFormData.deadline).toISOString(),
          evidenceCids: nextEvidenceCids,
          evidenceFiles: nextEvidenceFiles
        })
      });

      onProjectUpdated(selectedProjectDetail.projectId, response.data);
      handleCloseProjectDetailModal();
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể cập nhật dự án. Vui lòng thử lại sau.';
      if (error && typeof error === 'object' && 'details' in error) {
        const typedError = error as { details?: ApiErrorDetail[] };
        if (Array.isArray(typedError.details) && typedError.details.length > 0) {
          setUpdateFormErrors(currentErrors => ({ ...currentErrors, ...mapApiDetailsToUpdateFormErrors(typedError.details || []) }));
        }
        setUpdateProjectErrorMessage(resolveApiErrorMessage(error, fallbackErrorMessage));
      } else if (error && typeof error === 'object' && 'message' in error) {
        setUpdateProjectErrorMessage(resolveApiErrorMessage(error, fallbackErrorMessage));
      } else {
        setUpdateProjectErrorMessage(fallbackErrorMessage);
      }
    } finally {
      setIsUpdatingProject(false);
    }
  };

  return (
    <SectionCard title="Dự án của tổ chức" bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#F3F4F6] p-4">
        <input
          className="w-full flex-1 rounded border border-[#E5E7EB] bg-[#F3F4F6] px-3 py-2 text-xs sm:min-w-[220px]"
          placeholder="Tìm dự án theo tên..."
          value={searchKeyword}
          onChange={event => setSearchKeyword(event.target.value)}
        />
        <button type="button" onClick={() => setSelectedFilter('all')} className={`rounded-full px-3 py-1.5 text-xs ${selectedFilter === 'all' ? 'bg-[#0E7C6B] text-white' : 'border border-[#E5E7EB]'}`}>Tất cả</button>
        <button type="button" onClick={() => setSelectedFilter('active')} className={`rounded-full px-3 py-1.5 text-xs ${selectedFilter === 'active' ? 'bg-[#0E7C6B] text-white' : 'border border-[#E5E7EB]'}`}>Đang hoạt động</button>
        <button type="button" onClick={() => setSelectedFilter('pending')} className={`rounded-full px-3 py-1.5 text-xs ${selectedFilter === 'pending' ? 'bg-[#0E7C6B] text-white' : 'border border-[#E5E7EB]'}`}>Đang chờ</button>
        <button
          type="button"
          onClick={onOpenCreateProjectModal}
          disabled={!isCreateProjectAllowed}
          className="w-full rounded-[8px] bg-[#0E7C6B] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          ➕ Tạo dự án
        </button>
      </div>

      {!isCreateProjectAllowed ? (
        <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-2 rounded border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs text-[#9A3412]">
          <span>{createProjectBlockReason || 'Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án.'}</span>
          {onGoToBankSettings ? (
            <button type="button" onClick={onGoToBankSettings} className="rounded border border-[#FDBA74] px-2 py-1 font-semibold text-[#9A3412]">
              Đi tới Cài đặt ngân hàng
            </button>
          ) : null}
        </div>
      ) : null}

      {submitProjectErrorMessage ? (
        <div className="mx-4 mt-4 rounded border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">{submitProjectErrorMessage}</div>
      ) : null}

      {projectsErrorMessage ? (
        <div className="mx-4 mt-4 flex items-center justify-between gap-2 rounded border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">
          <span>{projectsErrorMessage}</span>
          {onRetryLoadProjects ? (
            <button type="button" onClick={onRetryLoadProjects} className="rounded border border-[#FCA5A5] px-2 py-1 text-[11px]">
              Thử lại
            </button>
          ) : null}
        </div>
      ) : null}

      {isProjectsLoading ? <p className="px-4 py-5 text-xs text-[#6B7280]">Đang tải dữ liệu dự án...</p> : null}

      <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-3">
        {filteredProjects.map(project => (
          <div key={project.key} className="rounded-[12px] border border-[#E5E7EB] bg-white shadow-sm">
            <div className={`relative flex h-[100px] items-center justify-center text-3xl ${project.thumbStyle}`}>
              {project.emoji}
              <span className={`absolute right-2 top-2 rounded-full px-2 py-1 text-[10px] font-semibold ${project.statusStyle}`}>{project.statusLabel}</span>
            </div>
            <div className="space-y-2 p-3">
              <p className="text-sm font-semibold leading-5">{project.name}</p>
              <p className="line-clamp-2 text-xs text-[#6B7280]">{project.description}</p>
              <p className="text-right text-[11px] font-semibold text-[#0E7C6B]">{project.progressLabel}</p>
              <ProgressBar progressPercent={project.progressPercent} className="h-[7px] rounded bg-[#F3F4F6]" />
              <div className="flex justify-between text-[11px] text-[#6B7280]"><span>{project.raisedAmount}</span><span>{project.goalAmount}</span></div>
              <div className="flex flex-wrap gap-2 text-[11px] text-[#6B7280]">{project.footerMeta.map(meta => <span key={meta}>{meta}</span>)}</div>
              {project.projectId ? (
                <div className="grid grid-cols-2 gap-2">
                  <a
                    href={`/organization/projects/${encodeURIComponent(project.projectId)}/geofence`}
                    className="block rounded border border-[#99F6E4] bg-[#F0FDFA] px-2 py-1.5 text-center text-xs font-semibold text-[#0F766E] hover:bg-[#CCFBF1]"
                  >
                    Thiết lập vùng địa lý
                  </a>
                  <a
                    href={`/organization/feedback?projectId=${encodeURIComponent(project.projectId)}`}
                    className="block rounded border border-[#BFDBFE] bg-[#EFF6FF] px-2 py-1.5 text-center text-xs font-semibold text-[#1D4ED8] hover:bg-[#DBEAFE]"
                  >
                    Quản lý feedback
                  </a>
                </div>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleOpenProjectDetail(project.projectId)}
                  className="flex-1 rounded border border-[#E5E7EB] py-1.5 text-xs"
                >
                  Chi tiết
                </button>
                {project.canSubmitForApproval ? (
                  <div className="flex-1">
                    <button
                      type="button"
                      onClick={() => handleSubmitProjectForApproval(project)}
                      disabled={!project.projectId || !project.hasGeofence || submittingProjectId === project.projectId}
                      title={!project.hasGeofence ? 'Thiết lập và lưu vùng địa lý trước khi gửi yêu cầu duyệt.' : undefined}
                      className="w-full rounded bg-[#0E7C6B] py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {submittingProjectId === project.projectId ? 'Đang submit...' : 'Gửi yêu cầu duyệt'}
                    </button>
                    {!project.hasGeofence ? (
                      <p className="mt-1 text-center text-[10px] text-[#9A3412]">Thiết lập vùng địa lý để mở gửi duyệt.</p>
                    ) : null}
                  </div>
                ) : project.canUpdateProject ? (
                  <button
                    type="button"
                    onClick={() => handleOpenProjectUpdate(project.projectId)}
                    className="flex-1 rounded bg-[#0E7C6B] py-1.5 text-xs text-white"
                  >
                    Cập nhật
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="flex-1 rounded bg-[#D1D5DB] py-1.5 text-xs text-[#6B7280]"
                  >
                    Cập nhật
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {!isProjectsLoading && filteredProjects.length === 0 ? (
        <p className="px-4 pb-5 text-xs text-[#6B7280]">Chưa có dự án nào hoặc không có kết quả phù hợp bộ lọc.</p>
      ) : null}

      {selectedProjectDetail ? (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
          <div className="my-4 max-h-[calc(100vh-2rem)] w-full max-w-[680px] overflow-y-auto rounded-[16px] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#F3F4F6] pb-3">
              <div>
                <p className="text-lg font-bold text-[#111827]">{isUpdateModalVisible ? 'Cập nhật dự án' : 'Chi tiết dự án'}</p>
                <p className="text-xs text-[#6B7280]">{isUpdateModalVisible ? 'Chỉnh sửa thông tin và minh chứng của dự án.' : 'Xem đầy đủ thông tin đã khai báo của dự án.'}</p>
              </div>
              <button type="button" onClick={handleCloseProjectDetailModal} className="rounded-full bg-[#F3F4F6] px-2.5 py-1 text-sm">✕</button>
            </div>

            {isUpdateModalVisible ? (
              <form className="mt-4 space-y-3" onSubmit={handleSubmitUpdateProject}>
                <input className="w-full rounded border border-[#E5E7EB] px-3 py-2 text-sm" value={updateFormData.name} onChange={event => handleChangeUpdateFormField('name', event.target.value)} placeholder="Tên dự án" />
                {updateFormErrors.name ? <p className="text-xs text-[#B91C1C]">{updateFormErrors.name}</p> : null}
                <textarea className="h-28 w-full rounded border border-[#E5E7EB] px-3 py-2 text-sm" value={updateFormData.description} onChange={event => handleChangeUpdateFormField('description', event.target.value)} placeholder="Mô tả dự án" />
                {updateFormErrors.description ? <p className="text-xs text-[#B91C1C]">{updateFormErrors.description}</p> : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <input type="number" min={1} className="w-full rounded border border-[#E5E7EB] px-3 py-2 text-sm" value={updateFormData.goalAmount} onChange={event => handleChangeUpdateFormField('goalAmount', event.target.value)} placeholder="Mục tiêu gây quỹ" />
                    {updateFormErrors.goalAmount ? <p className="mt-1 text-xs text-[#B91C1C]">{updateFormErrors.goalAmount}</p> : null}
                  </div>
                  <div>
                    <input type="datetime-local" className="w-full rounded border border-[#E5E7EB] px-3 py-2 text-sm" value={updateFormData.deadline} onChange={event => handleChangeUpdateFormField('deadline', event.target.value)} />
                    {updateFormErrors.deadline ? <p className="mt-1 text-xs text-[#B91C1C]">{updateFormErrors.deadline}</p> : null}
                  </div>
                </div>

                <div className="rounded border border-[#E5E7EB] p-3">
                  <p className="text-xs text-[#6B7280]">Nếu không chọn file mới, hệ thống sẽ giữ nguyên CID minh chứng cũ.</p>
                  <input type="file" multiple className="mt-2 block w-full text-xs" onChange={handleSelectUpdateEvidenceFiles} />
                  {updateFormErrors.evidenceFiles ? <p className="mt-1 text-xs text-[#B91C1C]">{updateFormErrors.evidenceFiles}</p> : null}
                  {selectedUpdateEvidenceFiles.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-[#374151]">
                      {selectedUpdateEvidenceFiles.map((fileItem, fileIndex) => (
                        <li key={`${fileItem.name}-${fileIndex}`} className="flex items-center justify-between rounded border border-[#E5E7EB] px-2 py-1">
                          <span className="truncate">{fileItem.name}</span>
                          <button type="button" onClick={() => handleRemoveUpdateEvidenceFile(fileIndex)} className="text-[#B91C1C]">Xóa</button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {updateProjectErrorMessage ? <p className="text-xs text-[#B91C1C]">{updateProjectErrorMessage}</p> : null}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={handleCloseProjectDetailModal} className="rounded border border-[#E5E7EB] px-3 py-2 text-xs">Hủy</button>
                  <button type="submit" disabled={isUpdatingProject} className="rounded bg-[#0E7C6B] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">{isUpdatingProject ? 'Đang cập nhật...' : 'Lưu cập nhật'}</button>
                </div>
              </form>
            ) : (
              <>
                <div className="mt-4 grid gap-2 text-sm text-[#374151] sm:grid-cols-2">
                  <p><span className="font-semibold">Mã dự án:</span> {selectedProjectDetail.projectId}</p>
                  <p><span className="font-semibold">Mã tổ chức:</span> {selectedProjectDetail.organizationId}</p>
                  <p><span className="font-semibold">Trạng thái:</span> {formatProjectStatusVietnamese(selectedProjectDetail.status)}</p>
                  <p><span className="font-semibold">Mục tiêu gây quỹ:</span> {formatCurrencyFromNumber(selectedProjectDetail.goalAmount)} ₫</p>
                  <p><span className="font-semibold">Hạn chót:</span> {formatDateTimeVietnamese(selectedProjectDetail.deadline)}</p>
                  <p><span className="font-semibold">Thời điểm gửi duyệt:</span> {formatDateTimeVietnamese(selectedProjectDetail.submittedAt)}</p>
                  <p><span className="font-semibold">Thời điểm duyệt:</span> {formatDateTimeVietnamese(selectedProjectDetail.reviewedAt)}</p>
                  <p><span className="font-semibold">Người duyệt:</span> {selectedProjectDetail.reviewedBy || 'Chưa có'}</p>
                </div>
                <div className="mt-3 rounded border border-[#E5E7EB] bg-[#F9FAFB] p-3 text-sm text-[#374151]"><p className="font-semibold text-[#111827]">Mô tả dự án</p><p className="mt-1 whitespace-pre-wrap">{selectedProjectDetail.description}</p></div>
                <div className="mt-3 rounded border border-[#E5E7EB] p-3">
                  <p className="text-sm font-semibold text-[#111827]">CID minh chứng (IPFS)</p>
                  {selectedProjectDetail.evidenceCids.length === 0 ? <p className="mt-1 text-xs text-[#6B7280]">Chưa có CID minh chứng.</p> : (
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">{selectedProjectDetail.evidenceCids.map((cidItem, evidenceIndex) => {
                      const evidenceFileItem = selectedProjectDetail.evidenceFiles?.find(fileItem => fileItem.cid === cidItem);

                      return (
                      <IpfsEvidencePreviewCard
                        key={`${selectedProjectDetail.projectId}-${cidItem}-${evidenceIndex}`}
                        cid={cidItem}
                        fileName={evidenceFileItem?.fileName || `Minh chứng #${evidenceIndex + 1}`}
                        mimeType={evidenceFileItem?.mimeType}
                        compact
                      />
                      );
                    })}</div>
                  )}
                </div>
                {selectedProjectDetail.rejectionReason ? <div className="mt-3 rounded border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]"><span className="font-semibold">Lý do từ chối:</span> {selectedProjectDetail.rejectionReason}</div> : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

/** Hàm render section Disbursement. Mục đích: hiển thị tab giải ngân và trạng thái đa chữ ký. */
/** Hàm lấy tên dự án từ danh sách dự án. Mục đích: hiển thị tên dự án thay vì ID khó nhớ. */
function getProjectName(projectId: string, projects: import('./types').ProjectSummary[]): string {
  const project = projects.find(p => p.projectId === projectId);
  return project ? project.name : projectId;
}

/** Hàm render danh sách giải ngân theo tab. Mục đích: tái sử dụng UI cho các tab khác nhau. */
export function DisbursementSection({
  activeDisbursementTab,
  onChangeDisbursementTab,
  disbursements = [],
  isDisbursementsLoading = false,
  disbursementsErrorMessage = null,
  onRetryLoadDisbursements,
  createdProjects = [],
  raisedAmountByProjectIdMap = new Map<string, number>(),
  onOpenCreateDisbursementModal
}: DisbursementSectionProps) {
  const tabItems = [
    { key: 'eligible', label: 'Đủ điều kiện' },
    { key: 'pending', label: 'Chờ duyệt' },
    { key: 'history', label: 'Lịch sử' }
  ] as const;

  const statusLabelMap = {
    eligible: '🟢 Sẵn sàng tạo yêu cầu',
    pending: '⏳ Đang chờ đủ chữ ký theo policy request',
    history: '📋 Lịch sử yêu cầu giải ngân'
  } as const;

  const pendingDisbursements = disbursements.filter(d => d.status === 'PENDING');
  const historyDisbursements = disbursements.filter(d => d.status !== 'PENDING');
  const organizationUserId = String(readAuthSession().userId || '').trim();
  const pendingDisbursementCardElementByRequestIdRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [processingSignRequestId, setProcessingSignRequestId] = useState<string | null>(null);
  const [signActionErrorMessageByRequestId, setSignActionErrorMessageByRequestId] = useState<Record<string, string>>({});
  const [recentlySignedRequestId, setRecentlySignedRequestId] = useState<string | null>(null);
  const [highlightedRequestId, setHighlightedRequestId] = useState<string | null>(null);

  // Lọc các dự án ACTIVE và không có yêu cầu PENDING nào
  const eligibleProjects = createdProjects.filter(p => {
    if (p.status !== 'ACTIVE') return false;
    const raisedAmount = raisedAmountByProjectIdMap.get(p.projectId) || 0;
    if (raisedAmount < minimumPayosTransferAmountVnd) return false;
    const hasPending = pendingDisbursements.some(d => d.projectId === p.projectId);
    return !hasPending;
  });

  /** Hàm cuộn tới card vừa ký duyệt thành công. Mục đích: phản hồi trực quan ngay trên danh sách pending cho người dùng tổ chức. */
  useEffect(() => {
    if (!recentlySignedRequestId) {
      return;
    }

    const targetCardElement = pendingDisbursementCardElementByRequestIdRef.current[recentlySignedRequestId];
    if (!targetCardElement) {
      setRecentlySignedRequestId(null);
      return;
    }

    targetCardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedRequestId(recentlySignedRequestId);

    const clearHighlightTimeout = window.setTimeout(() => {
      setHighlightedRequestId(currentHighlightedRequestId => {
        if (currentHighlightedRequestId === recentlySignedRequestId) {
          return null;
        }

        return currentHighlightedRequestId;
      });
      setRecentlySignedRequestId(currentRecentlySignedRequestId => {
        if (currentRecentlySignedRequestId === recentlySignedRequestId) {
          return null;
        }

        return currentRecentlySignedRequestId;
      });
    }, 2200);

    return () => {
      window.clearTimeout(clearHighlightTimeout);
    };
  }, [pendingDisbursements, recentlySignedRequestId]);

  /** Hàm ký duyệt request pending từ vai trò tổ chức. Mục đích: cho phép organization hoàn tất chữ ký của chính mình theo UC7.2. */
  async function handleSignPendingDisbursementRequest(requestId: string): Promise<void> {
    if (processingSignRequestId) {
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setSignActionErrorMessageByRequestId(currentErrorMap => ({
        ...currentErrorMap,
        [requestId]: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để ký duyệt.'
      }));
      return;
    }

    setProcessingSignRequestId(requestId);
    setSignActionErrorMessageByRequestId(currentErrorMap => {
      const nextErrorMap = { ...currentErrorMap };
      delete nextErrorMap[requestId];
      return nextErrorMap;
    });

    try {
      await fetchApi(buildApiUrl(`/api/disbursement/${encodeURIComponent(requestId)}/sign`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({ comment: 'Approved from organization dashboard' })
      });

      if (onRetryLoadDisbursements) {
        await onRetryLoadDisbursements();
      }

      setRecentlySignedRequestId(requestId);
    } catch (error: unknown) {
      setSignActionErrorMessageByRequestId(currentErrorMap => ({
        ...currentErrorMap,
        [requestId]: resolveApiErrorMessage(error, 'Không thể ký duyệt yêu cầu giải ngân. Vui lòng thử lại sau.')
      }));
    } finally {
      setProcessingSignRequestId(null);
    }
  }

  return (
    <SectionCard title="Yêu cầu giải ngân">
      <div className="mb-4 flex gap-2">
        {tabItems.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChangeDisbursementTab(tab.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${activeDisbursementTab === tab.key ? 'bg-[#0E7C6B] text-white' : 'bg-[#F3F4F6] text-[#4B5563]'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isDisbursementsLoading ? (
        <div className="py-8 text-center text-sm text-[#6B7280]">Đang tải dữ liệu...</div>
      ) : disbursementsErrorMessage ? (
        <div className="flex flex-col items-center justify-center py-8">
          <p className="mb-2 text-sm text-[#DC2626]">{disbursementsErrorMessage}</p>
          {onRetryLoadDisbursements && (
            <button type="button" onClick={onRetryLoadDisbursements} className="rounded bg-[#F3F4F6] px-4 py-2 text-xs font-medium">Thử lại</button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {activeDisbursementTab === 'eligible' && (
            eligibleProjects.length === 0 ? (
              <p className="py-4 text-center text-sm text-[#6B7280]">Không có dự án nào đủ điều kiện giải ngân.</p>
            ) : (
              eligibleProjects.map(project => (
                <div key={project.projectId} className="rounded-[12px] border border-[#E5E7EB] p-4">
                  <div className="mb-3 flex items-start justify-between">
                    <div>
                      <p className="font-semibold">{project.name}</p>
                      <p className="text-xs text-[#6B7280]">Đủ điều kiện giải ngân</p>
                      <p className="mt-1 text-xs text-[#4B5563]">Đã quyên góp: {formatCurrencyFromNumber(raisedAmountByProjectIdMap.get(project.projectId) || 0)} ₫</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[#0E7C6B]">{statusLabelMap['eligible']}</p>
                    <button
                      type="button"
                      onClick={() => onOpenCreateDisbursementModal?.(project)}
                      className="rounded-[8px] bg-[#0E7C6B] px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Tạo yêu cầu giải ngân
                    </button>
                  </div>
                </div>
              ))
            )
          )}

          {activeDisbursementTab === 'pending' && (
            pendingDisbursements.length === 0 ? (
              <p className="py-4 text-center text-sm text-[#6B7280]">Không có yêu cầu giải ngân nào đang chờ duyệt.</p>
            ) : (
              pendingDisbursements.map(disbursement => {
                const adminSigned = disbursement.approvals.some(a => a.signerRole === 'ADMIN_SIGNER');
                const orgSigned = disbursement.approvals.some(a => a.signerRole === 'ORG_SIGNER');
                const orgSignedByCurrentUser = disbursement.approvals.some(a =>
                  a.signerRole === 'ORG_SIGNER' && a.signerUserId === organizationUserId
                );
                const regSigned = disbursement.approvals.some(a => a.signerRole === 'REGULATORY_SIGNER');
                return (
                  <div
                    key={disbursement.requestId}
                    ref={cardElement => {
                      pendingDisbursementCardElementByRequestIdRef.current[disbursement.requestId] = cardElement;
                    }}
                    className={`rounded-[12px] border border-[#E5E7EB] p-4 transition ${highlightedRequestId === disbursement.requestId ? 'ring-2 ring-[#34D399] ring-offset-1' : ''}`}
                  >
                    <div className="mb-3 flex items-start justify-between">
                      <div>
                        <p className="font-semibold">{getProjectName(disbursement.projectId, createdProjects)}</p>
                        <p className="text-xs text-[#6B7280]">Yêu cầu rút tiền</p>
                        <p className="mt-1 text-xs text-[#4B5563]">Mục đích: {disbursement.usagePurpose}</p>
                      </div>
                      <p className="text-lg font-bold text-[#0E7C6B]">{formatCurrencyFromNumber(disbursement.amount)} ₫</p>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className={`rounded border p-2.5 ${adminSigned ? 'border-[#E5E7EB] bg-[#F9FAFB]' : 'border-[#FCD34D] bg-[#FFFBEB]'}`}>
                        <p className={`font-medium ${adminSigned ? '' : 'text-[#92400E]'}`}>
                          {adminSigned ? '✅ Admin hệ thống đã ký' : '⏳ Admin hệ thống chưa ký'}
                        </p>
                      </div>
                      <div className={`rounded border p-2.5 ${orgSigned ? 'border-[#E5E7EB] bg-[#F9FAFB]' : 'border-[#FCD34D] bg-[#FFFBEB]'}`}>
                        <p className={`font-medium ${orgSigned ? '' : 'text-[#92400E]'}`}>
                          {orgSigned ? '✅ Đại diện tổ chức đã ký' : '⏳ Đại diện tổ chức chưa ký'}
                        </p>
                      </div>
                      <div className={`rounded border p-2.5 ${regSigned ? 'border-[#E5E7EB] bg-[#F9FAFB]' : 'border-[#FCD34D] bg-[#FFFBEB]'}`}>
                        <p className={`font-medium ${regSigned ? '' : 'text-[#92400E]'}`}>
                          {regSigned ? '✅ Cơ quan giám sát đã ký' : '⏳ Cơ quan giám sát chưa ký'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-[#B45309]">{statusLabelMap['pending']}</p>
                      <p className="text-xs font-semibold text-[#92400E]">{`${disbursement.approvals.length}/${disbursement.requiredApprovals} chữ ký`}</p>
                    </div>

                    {!orgSigned ? (
                      <div className="mt-3 space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            void handleSignPendingDisbursementRequest(disbursement.requestId);
                          }}
                          disabled={processingSignRequestId !== null}
                          className="w-full rounded-[8px] bg-[#0E7C6B] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#0B675A] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {processingSignRequestId === disbursement.requestId ? 'Đang ký duyệt...' : 'Ký duyệt với vai trò tổ chức'}
                        </button>

                        {signActionErrorMessageByRequestId[disbursement.requestId] ? (
                          <p className="text-xs font-medium text-[#DC2626]">{signActionErrorMessageByRequestId[disbursement.requestId]}</p>
                        ) : null}
                      </div>
                    ) : null}

                    {orgSignedByCurrentUser ? (
                      <p className="mt-3 rounded-[8px] border border-[#A7F3D0] bg-[#ECFDF5] px-3 py-2 text-xs font-semibold text-[#065F46]">
                        ✅ Bạn đã ký duyệt yêu cầu này với vai trò đại diện tổ chức.
                      </p>
                    ) : null}
                  </div>
                );
              })
            )
          )}

          {activeDisbursementTab === 'history' && (
            historyDisbursements.length === 0 ? (
              <p className="py-4 text-center text-sm text-[#6B7280]">Không có lịch sử giải ngân nào.</p>
            ) : (
              historyDisbursements.map(disbursement => (
                <div key={disbursement.requestId} className="rounded-[12px] border border-[#E5E7EB] p-4">
                  <div className="mb-3 flex items-start justify-between">
                    <div>
                      <p className="font-semibold">{getProjectName(disbursement.projectId, createdProjects)}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6B7280]">
                        <span>Yêu cầu rút tiền</span>
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none ${getDisbursementStatusBadgeClassName(disbursement)}`}>
                          {formatDisbursementStatusVietnamese(disbursement)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#4B5563]">Mục đích: {disbursement.usagePurpose}</p>
                    </div>
                    <p className="text-lg font-bold text-[#0E7C6B]">{formatCurrencyFromNumber(disbursement.amount)} ₫</p>
                  </div>
                </div>
              ))
            )
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** Hàm kiểm tra dữ liệu form giải ngân. Mục đích: chặn submit sai trước khi upload minh chứng và gọi API. */
function validateDisbursementAmountField(
  amountInputValue: string,
  maxWithdrawableAmount: number | null,
  shouldRequireValue: boolean
): string | undefined {
  const normalizedAmountValue = amountInputValue.trim();

  if (!normalizedAmountValue) {
    return shouldRequireValue ? 'Vui lòng nhập số tiền cần giải ngân.' : undefined;
  }

  if (!/^\d+$/.test(normalizedAmountValue)) {
    return 'Số tiền giải ngân chỉ được nhập số nguyên VNĐ.';
  }

  const amountValue = Number(normalizedAmountValue);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return 'Số tiền giải ngân phải lớn hơn 0.';
  }

  if (!Number.isSafeInteger(amountValue)) {
    return 'Số tiền giải ngân vượt quá giới hạn số nguyên cho phép.';
  }

  if (amountValue < minimumPayosTransferAmountVnd) {
    return `Số tiền giải ngân tối thiểu là ${formatCurrencyFromNumber(minimumPayosTransferAmountVnd)} VNĐ mới đạt điều kiện giải ngân.`;
  }

  if (maxWithdrawableAmount !== null && amountValue > maxWithdrawableAmount) {
    return 'Số tiền vượt quá hạn mức giải ngân khả dụng của dự án.';
  }

  return undefined;
}

/** Hàm kiểm tra dữ liệu form giải ngân. Mục đích: chặn submit sai trước khi upload minh chứng và gọi API. */
function validateCreateDisbursementForm(
  formData: CreateDisbursementFormData,
  evidencePhotos: CapturedEvidencePhoto[],
  maxWithdrawableAmount: number | null
): CreateDisbursementFormErrors {
  const nextFormErrors: CreateDisbursementFormErrors = {};
  const amountErrorMessage = validateDisbursementAmountField(formData.amount, maxWithdrawableAmount, true);
  if (amountErrorMessage) {
    nextFormErrors.amount = amountErrorMessage;
  }

  if (!formData.usagePurpose.trim()) {
    nextFormErrors.usagePurpose = 'Vui lòng nhập mục đích sử dụng tiền.';
  } else if (formData.usagePurpose.trim().length < 10) {
    nextFormErrors.usagePurpose = 'Mục đích sử dụng tiền phải tối thiểu 10 ký tự.';
  }

  if (formData.requestMode === 'EMERGENCY' && !formData.emergencyReason.trim()) {
    nextFormErrors.emergencyReason = 'Vui lòng nhập lý do khẩn cấp cho chế độ Khẩn cấp.';
  }

  if (evidencePhotos.length === 0) {
    nextFormErrors.evidencePhotos = 'Vui lòng chụp ít nhất một ảnh minh chứng cùng vị trí GPS.';
  }

  return nextFormErrors;
}

/** Hàm render modal tạo yêu cầu giải ngân. Mục đích: cho tổ chức nhập dữ liệu theo FR7 rồi tạo request. */
export function CreateDisbursementModal({
  project,
  beneficiaryBankAccount,
  onClose,
  onCreated
}: CreateDisbursementModalProps) {
  const [formData, setFormData] = useState<CreateDisbursementFormData>(createDisbursementDefaultFormState);
  const [formErrors, setFormErrors] = useState<CreateDisbursementFormErrors>({});
  const [evidencePhotos, setEvidencePhotos] = useState<CapturedEvidencePhoto[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingMaxWithdrawable, setIsLoadingMaxWithdrawable] = useState(true);
  const [maxWithdrawableAmount, setMaxWithdrawableAmount] = useState<number | null>(null);
  const [maxWithdrawableErrorMessage, setMaxWithdrawableErrorMessage] = useState<string | null>(null);
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(null);

  /** Hàm cập nhật từng field form giải ngân. Mục đích: đồng bộ state và báo lỗi realtime cho amount nếu không phải số nguyên VNĐ. */
  const handleChangeFormField = (fieldName: keyof CreateDisbursementFormData, fieldValue: string) => {
    const normalizedFieldValue = fieldName === 'amount'
      ? fieldValue.replace(/\s+/g, '')
      : fieldValue;

    if (fieldName === 'amount' && normalizedFieldValue && !/^\d+$/.test(normalizedFieldValue)) {
      setFormErrors(currentFormErrors => ({
        ...currentFormErrors,
        amount: 'Số tiền giải ngân chỉ được nhập số nguyên VNĐ.'
      }));
      setSubmitErrorMessage(null);
      return;
    }

    const nextFormData: CreateDisbursementFormData = {
      ...formData,
      [fieldName]: normalizedFieldValue
    };

    setFormData(nextFormData);

    if (fieldName === 'amount') {
      const amountErrorMessage = validateDisbursementAmountField(nextFormData.amount, maxWithdrawableAmount, false);
      setFormErrors(currentFormErrors => ({
        ...currentFormErrors,
        amount: amountErrorMessage
      }));
    } else {
      setFormErrors(currentFormErrors => ({
        ...currentFormErrors,
        [fieldName]: undefined
      }));
    }

    setSubmitErrorMessage(null);
  };

  useEffect(() => {
    let isComponentMounted = true;

    /** Hàm tải hạn mức giải ngân tối đa. Mục đích: hiển thị rule reserve 20% từ backend đúng với FR7. */
    const loadMaxWithdrawableAmount = async () => {
      const authSession = readAuthSession();
      if (!authSession?.accessToken) {
        if (isComponentMounted) {
          setIsLoadingMaxWithdrawable(false);
          setMaxWithdrawableErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        }
        return;
      }

      setIsLoadingMaxWithdrawable(true);
      setMaxWithdrawableErrorMessage(null);

      try {
        const response = await fetchApi<MaxWithdrawableResponse>(buildApiUrl(`/api/disbursement/max-withdrawable/${project.projectId}`), {
          method: 'GET',
          headers: { Authorization: `Bearer ${authSession.accessToken}` }
        });

        if (!isComponentMounted) {
          return;
        }

        setMaxWithdrawableAmount(Number(response.data.maxAmount));
      } catch (error: unknown) {
        if (!isComponentMounted) {
          return;
        }

        setMaxWithdrawableErrorMessage(resolveApiErrorMessage(error, 'Không thể lấy hạn mức giải ngân tối đa. Vui lòng thử lại sau.'));
      } finally {
        if (isComponentMounted) {
          setIsLoadingMaxWithdrawable(false);
        }
      }
    };

    void loadMaxWithdrawableAmount();

    return () => {
      isComponentMounted = false;
    };
  }, [project.projectId]);

  /** Hàm submit form giải ngân. Ảnh camera/GPS được backend kiểm tra và pin cùng request. */
  const handleSubmitCreateDisbursement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextFormErrors = validateCreateDisbursementForm(formData, evidencePhotos, maxWithdrawableAmount);
    if (Object.keys(nextFormErrors).length > 0) {
      setFormErrors(nextFormErrors);
      setSubmitErrorMessage('Vui lòng kiểm tra lại các trường bắt buộc trước khi gửi yêu cầu giải ngân.');
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setSubmitErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsSubmitting(true);
    setSubmitErrorMessage(null);

    try {
      const createResponse = await fetchApi<import('./types').DisbursementResult>(buildApiUrl('/api/disbursement/create'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({
          projectId: project.projectId,
          amount: Number(formData.amount),
          usagePurpose: formData.usagePurpose.trim(),
          evidencePhotos: evidencePhotos.map(({ localId, previewObjectUrl, ...photo }) => photo),
          clientSubmittedAt: new Date().toISOString(),
          requestMode: formData.requestMode,
          emergencyReason: formData.requestMode === 'EMERGENCY' ? formData.emergencyReason.trim() : undefined,
          beneficiaryBankAccount: {
            bankName: beneficiaryBankAccount.bankName,
            bankAccountNumber: beneficiaryBankAccount.bankAccountNumber,
            accountHolderName: beneficiaryBankAccount.accountHolderName,
            branchName: beneficiaryBankAccount.branchName || undefined
          }
        })
      });

      onCreated(createResponse.data);
      onClose();
    } catch (error: unknown) {
      setSubmitErrorMessage(resolveApiErrorMessage(error, 'Không thể tạo yêu cầu giải ngân. Vui lòng thử lại sau.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-4 flex max-h-[calc(100vh-2rem)] w-full max-w-[720px] flex-col overflow-hidden rounded-[18px] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#F3F4F6] p-5">
          <div>
            <p className="mb-1 text-2xl">🏦</p>
            <p className="text-lg font-bold">Tạo yêu cầu giải ngân</p>

          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-full bg-[#F3F4F6]">✕</button>
        </div>

        <form className="min-h-0 space-y-4 overflow-y-auto p-5 text-sm" onSubmit={handleSubmitCreateDisbursement}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2 rounded-[12px] border border-[#E5E7EB] bg-[#F9FAFB] p-4">
              <p className="font-semibold text-[#111827]">{project.name}</p>
              <p className="mt-1 text-xs text-[#6B7280]">Yêu cầu được duyệt theo ngưỡng chữ ký động của(2/3 hoặc 3/3).</p>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-[#374151]">Chế độ yêu cầu</p>
              <select
                className="w-full rounded border border-[#D1D5DB] px-3 py-2"
                value={formData.requestMode}
                onChange={event => handleChangeFormField('requestMode', event.target.value as 'NORMAL' | 'EMERGENCY')}
              >
                <option value="NORMAL">Thông thường</option>
                <option value="EMERGENCY">Khẩn cấp</option>
              </select>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-[#374151]">Số tiền yêu cầu giải ngân (VNĐ)</p>
              <input
                className="w-full rounded border border-[#D1D5DB] px-3 py-2"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Ví dụ: 15000000"
                value={formData.amount}
                aria-invalid={Boolean(formErrors.amount)}
                onChange={event => handleChangeFormField('amount', event.target.value)}
              />
              {formErrors.amount ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.amount}</p> : null}
              {isLoadingMaxWithdrawable ? (
                <p className="mt-1 text-xs text-[#6B7280]">Đang tải hạn mức giải ngân tối đa...</p>
              ) : maxWithdrawableErrorMessage ? (
                <p className="mt-1 text-xs text-[#DC2626]">{maxWithdrawableErrorMessage}</p>
              ) : (
                <p className="mt-1 text-xs text-[#0E7C6B]">Hạn mức khả dụng tối đa: {maxWithdrawableAmount !== null ? `${formatCurrencyFromNumber(maxWithdrawableAmount)} ₫` : '--'} · Reserve: 20%</p>
              )}
            </div>

            <div className="rounded-[12px] border border-[#E5E7EB] bg-[#F9FAFB] p-4 text-xs text-[#374151]">
              <p className="font-semibold">Tài khoản ngân hàng thụ hưởng</p>
              <p className="mt-2">Ngân hàng: {beneficiaryBankAccount.bankName}</p>
              <p>Số tài khoản: {beneficiaryBankAccount.bankAccountNumber}</p>
              <p>Chủ tài khoản: {beneficiaryBankAccount.accountHolderName}</p>
              {beneficiaryBankAccount.branchName ? <p>Chi nhánh: {beneficiaryBankAccount.branchName}</p> : null}
            </div>

            <div className="md:col-span-2">
              <p className="mb-1 text-xs font-semibold text-[#374151]">Mục đích sử dụng tiền</p>
              <textarea className="min-h-[96px] w-full rounded border border-[#D1D5DB] px-3 py-2" placeholder="Mô tả rõ mục đích sử dụng khoản giải ngân này" value={formData.usagePurpose} onChange={event => handleChangeFormField('usagePurpose', event.target.value)} />
              {formErrors.usagePurpose ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.usagePurpose}</p> : null}
            </div>

            {formData.requestMode === 'EMERGENCY' ? (
              <div className="md:col-span-2">
                <p className="mb-1 text-xs font-semibold text-[#374151]">Lý do khẩn cấp</p>
                <textarea
                  className="min-h-[72px] w-full rounded border border-[#D1D5DB] px-3 py-2"
                  placeholder="Mô tả lý do cần giải ngân khẩn cấp để phục vụ audit"
                  value={formData.emergencyReason}
                  onChange={event => handleChangeFormField('emergencyReason', event.target.value)}
                />
                {formErrors.emergencyReason ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.emergencyReason}</p> : null}
              </div>
            ) : null}

            <div className="md:col-span-2">
              <EvidenceCameraCapture
                maxPhotos={5}
                photos={evidencePhotos}
                onChange={nextPhotos => {
                  setEvidencePhotos(nextPhotos);
                  setFormErrors(currentErrors => ({ ...currentErrors, evidencePhotos: undefined }));
                  setSubmitErrorMessage(null);
                }}
                moduleLabel="yêu cầu giải ngân"
                disabled={isSubmitting}
              />
              {formErrors.evidencePhotos ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.evidencePhotos}</p> : null}
            </div>
          </div>

          <div className="space-y-1 rounded-[12px] border border-[#D1FAE5] bg-[#ECFDF5] px-3 py-2 text-xs text-[#065F46]">
            <p>Yêu cầu sau khi tạo sẽ chờ ký duyệt.</p>
            {formData.requestMode === 'EMERGENCY' ? (
              <p>Chế độ khẩn cấp luôn cần đủ 3/3 chữ ký: tổ chức, quản trị viên và cơ quan giám sát.</p>
            ) : (
              <p>Chế độ thông thường cần 2/3 chữ ký khi dự án đạt ngưỡng gây quỹ nhanh; nếu chưa đạt ngưỡng này, yêu cầu cần đủ 3/3 chữ ký.</p>
            )}
          </div>

          {submitErrorMessage ? <p className="rounded border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">{submitErrorMessage}</p> : null}

          {maxWithdrawableErrorMessage ? (
            <p className="rounded border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs text-[#92400E]">
              Không thể tải hạn mức giải ngân tối đa từ blockchain. Bạn vẫn có thể gửi yêu cầu, hệ thống backend sẽ kiểm tra hạn mức trước khi tạo request.
            </p>
          ) : null}

          <div className="flex gap-2 border-t border-[#F3F4F6] pt-4">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="flex-1 rounded bg-[#F3F4F6] py-2 text-sm">Hủy</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 rounded bg-[#0E7C6B] py-2 text-sm font-semibold text-white disabled:opacity-60">{isSubmitting ? 'Đang tạo yêu cầu...' : 'Tạo yêu cầu giải ngân'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Hàm render section Transparency. Mục đích: hiển thị bộ lọc, bảng giao dịch và phân trang. */
export function TransparencySection() {
  return (
    <SectionCard title="Lịch sử giao dịch on-chain" bodyClassName="p-0">
      <div className="flex flex-wrap gap-2 border-b border-[#F3F4F6] p-4">
        <input className="w-full flex-1 rounded border border-[#E5E7EB] bg-[#F3F4F6] px-3 py-2 text-xs sm:min-w-[200px]" placeholder="Tìm theo hash hoặc ví..." />
        <select className="w-full rounded border border-[#E5E7EB] px-2 py-2 text-xs sm:w-auto">
          <option>Tất cả loại</option>
        </select>
        <button type="button" className="w-full rounded border border-[#E5E7EB] px-3 py-2 text-xs sm:w-auto">⤓ Export CSV</button>
      </div>

      <div className="space-y-3 p-4 md:hidden">
        {transparencyTransactionRows.map(row => (
          <div key={row.hash} className="rounded-[12px] border border-[#E5E7EB] bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#111827]">{row.time}</p>
                <p className="mt-1 break-all text-xs text-[#2563EB]">{row.hash}</p>
              </div>
              <StatusBadge label={row.status} className={row.statusStyle} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-[#374151]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6B7280]">Loại</span>
                <StatusBadge label={row.type} className={row.typeStyle} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6B7280]">Số tiền</span>
                <span className="break-words text-right font-semibold text-[#111827]">{row.amount}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6B7280]">Nguồn</span>
                <span className="break-all text-right text-[#111827]">{row.sender}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-[#F3F4F6] text-xs uppercase text-[#6B7280]">
            <tr>
              <th className="p-3">Thời gian</th>
              <th>Loại</th>
              <th>Số tiền</th>
              <th>Nguồn</th>
              <th>Hash</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {transparencyTransactionRows.map(row => (
              <tr key={row.hash} className="border-t border-[#F3F4F6]">
                <td className="p-3">{row.time}</td>
                <td><StatusBadge label={row.type} className={row.typeStyle} /></td>
                <td>{row.amount}</td>
                <td>{row.sender}</td>
                <td className="text-[#2563EB]">{row.hash}</td>
                <td><StatusBadge label={row.status} className={row.statusStyle} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center gap-2 p-4 text-xs">
        <button type="button" className="rounded border border-[#E5E7EB] px-2 py-1">‹</button>
        <button type="button" className="rounded border border-[#0E7C6B] bg-[#0E7C6B] px-2 py-1 text-white">1</button>
        <button type="button" className="rounded border border-[#E5E7EB] px-2 py-1">2</button>
        <button type="button" className="rounded border border-[#E5E7EB] px-2 py-1">›</button>
      </div>
    </SectionCard>
  );
}


const vietnameseBankNameOptions = [
  'Vietcombank',
  'BIDV',
  'VietinBank',
  'Agribank',
  'ACB',
  'Techcombank',
  'MB Bank',
  'VPBank',
  'Sacombank',
  'TPBank',
  'OCB',
  'HDBank',
  'VIB',
  'SHB',
  'MSB',
  'SeABank',
  'LPBank',
  'PVcomBank',
  'Eximbank',
  'Bac A Bank',
  'Nam A Bank',
  'ABBANK',
  'BVBank',
  'Vietbank',
  'SCB',
  'DongA Bank',
  'PGBank',
  'Saigonbank',
  'Kienlongbank',
  'BaoViet Bank',
  'OceanBank',
  'GPBank',
  'CBBank',
  'HSBC',
  'Shinhan Bank',
  'Standard Chartered',
  'UOB',
  'Public Bank'
];

/** Hàm chuẩn hóa tên chủ tài khoản về chữ in hoa. Mục đích: đồng bộ định dạng dữ liệu trước khi hiển thị và submit. */
function normalizeAccountHolderName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

/** Hàm validate form tài khoản thụ hưởng. Mục đích: chặn submit sai dữ liệu ngay tại frontend. */
function validateBeneficiaryBankAccountForm(formData: BeneficiaryBankAccountFormData): BeneficiaryBankAccountFormErrors {
  const formErrors: BeneficiaryBankAccountFormErrors = {};

  if (!formData.bankName.trim()) {
    formErrors.bankName = 'Vui lòng chọn ngân hàng.';
  }
  if (!formData.accountHolderName.trim()) {
    formErrors.accountHolderName = 'Vui lòng nhập tên chủ tài khoản.';
  }
  if (!/^[0-9]{8,20}$/.test(formData.bankAccountNumber.trim())) {
    formErrors.bankAccountNumber = 'Số tài khoản chỉ gồm chữ số và dài từ 8 đến 20 ký tự.';
  }

  return formErrors;
}

type BankSettingsPanelProps = {
  isBankSetupHighlighted: boolean;
  isOrganizationKycLoading: boolean;
  organizationKycErrorMessage: string | null;
  onRetryLoadOrganizationKycSubmissions: () => Promise<void> | void;
  latestOrganizationKycSubmission: SettingsSectionProps['organizationKycSubmissionList'][number] | null;
  bankFormData: BeneficiaryBankAccountFormData;
  bankFormErrors: BeneficiaryBankAccountFormErrors;
  bankSubmitErrorMessage: string | null;
  isSubmittingBankForm: boolean;
  bankSubmitSuccessMessage: string | null;
  onBankFormDataChange: (value: BeneficiaryBankAccountFormData) => void;
  onBankFormErrorsChange: (value: BeneficiaryBankAccountFormErrors) => void;
  onBankSubmitErrorMessageChange: (value: string | null) => void;
  onBankSubmitSuccessMessageChange: (value: string | null) => void;
  onSubmittingBankFormChange: (value: boolean) => void;
  onBankSubmissionSuccess: () => Promise<void> | void;
};

/** Hàm render panel Ngân hàng. Mục đích: hiển thị trạng thái thật và cho phép gửi hồ sơ ngân hàng thụ hưởng. */
function BankSettingsPanel({
  isBankSetupHighlighted,
  isOrganizationKycLoading,
  organizationKycErrorMessage,
  onRetryLoadOrganizationKycSubmissions,
  latestOrganizationKycSubmission,
  bankFormData,
  bankFormErrors,
  bankSubmitErrorMessage,
  isSubmittingBankForm,
  bankSubmitSuccessMessage,
  onBankFormDataChange,
  onBankFormErrorsChange,
  onBankSubmitErrorMessageChange,
  onBankSubmitSuccessMessageChange,
  onSubmittingBankFormChange,
  onBankSubmissionSuccess
}: BankSettingsPanelProps) {
  const bankStatus = latestOrganizationKycSubmission?.status || null;
  const [isBankFormHiddenAfterSuccessfulSubmit, setIsBankFormHiddenAfterSuccessfulSubmit] = useState(false);
  const shouldShowBankForm = bankStatus === null && !isBankFormHiddenAfterSuccessfulSubmit;
  const statusLabel = bankStatus === 'APPROVED'
    ? '✓ Đã phê duyệt'
    : bankStatus === 'REJECTED'
      ? '❌ Bị từ chối'
      : bankStatus === 'SUBMISSION_ERROR'
        ? '⚠️ Nộp hồ sơ lỗi'
        : bankStatus === 'PENDING_REVIEW'
          ? '⏳ Đang chờ duyệt'
          : '⚠️ Chưa liên kết';
  const statusStyle = bankStatus === 'APPROVED' ? 'bg-[#DCFCE7] text-[#166534]' : bankStatus === 'REJECTED' ? 'bg-[#FEE2E2] text-[#991B1B]' : bankStatus === 'SUBMISSION_ERROR' ? 'bg-[#FEE2E2] text-[#991B1B]' : bankStatus === 'PENDING_REVIEW' ? 'bg-[#FEF3C7] text-[#92400E]' : 'bg-[#FEE2E2] text-[#991B1B]';
  const submittedAtLabel = latestOrganizationKycSubmission?.submittedAt
    ? new Date(latestOrganizationKycSubmission.submittedAt).toLocaleString('vi-VN')
    : null;

  /** Hàm đồng bộ trạng thái ẩn form theo dữ liệu KYC mới nhất. Mục đích: đảm bảo UI luôn bám dữ liệu backend sau khi tải lại. */
  useEffect(() => {
    if (bankStatus !== null) {
      setIsBankFormHiddenAfterSuccessfulSubmit(true);
      return;
    }

    setIsBankFormHiddenAfterSuccessfulSubmit(false);
  }, [bankStatus]);

  /** Hàm cập nhật field form ngân hàng. Mục đích: đổi state input và xóa lỗi field tương ứng khi người dùng sửa. */
  const handleBankFieldChange = (fieldName: keyof BeneficiaryBankAccountFormData, value: string) => {
    onBankFormDataChange({ ...bankFormData, [fieldName]: value });
    if (bankFormErrors[fieldName]) {
      onBankFormErrorsChange({ ...bankFormErrors, [fieldName]: undefined });
    }
  };

  /** Hàm submit form ngân hàng. Mục đích: gọi API thật để tạo hồ sơ PENDING_REVIEW và reload dữ liệu trạng thái. */
  const handleSubmitBeneficiaryBankAccount = async () => {
    if (isSubmittingBankForm || isOrganizationKycLoading) {
      return;
    }

    onBankSubmitErrorMessageChange(null);
    onBankSubmitSuccessMessageChange(null);
    const nextFormErrors = validateBeneficiaryBankAccountForm(bankFormData);
    onBankFormErrorsChange(nextFormErrors);
    if (Object.keys(nextFormErrors).length > 0) {
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      onBankSubmitErrorMessageChange('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    onSubmittingBankFormChange(true);
    try {
      await fetchApi(buildApiUrl('/auth/organization/kyc-submissions/me/beneficiary-bank-account'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({
          bankName: bankFormData.bankName.trim(),
          bankAccountNumber: bankFormData.bankAccountNumber.trim(),
          accountHolderName: bankFormData.accountHolderName.trim(),
          branchName: bankFormData.branchName.trim()
        })
      });

      onBankSubmitSuccessMessageChange('Đã gửi duyệt tài khoản thành công. Hồ sơ đang chờ xác minh.');
      setIsBankFormHiddenAfterSuccessfulSubmit(true);

      // Logic này reset form sau khi submit thành công để tránh giữ lại dữ liệu cũ khi người dùng quay lại trạng thái cần nhập lại.
      onBankFormDataChange({
        bankName: '',
        bankAccountNumber: '',
        accountHolderName: '',
        branchName: ''
      });
      onBankFormErrorsChange({});

      // Sau khi submit thành công, luôn tải lại dữ liệu KYC từ backend để UI đồng bộ đúng trạng thái thật.
      await Promise.resolve(onBankSubmissionSuccess());
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể gửi duyệt tài khoản ngân hàng. Vui lòng thử lại sau.';
      onBankSubmitErrorMessageChange(resolveApiErrorMessage(error, fallbackErrorMessage));
    } finally {
      onSubmittingBankFormChange(false);
    }
  };

  return (
    <SectionCard
      title="Tài khoản ngân hàng nhận giải ngân"
      className={isBankSetupHighlighted ? 'ring-2 ring-[#0E7C6B]/35 ring-offset-2 ring-offset-[#F8FAFB]' : ''}
    >
      {/* Khối trạng thái chính — hiển thị badge, thời gian, và chi tiết ngân hàng đã duyệt */}
      <div className="space-y-3">
        {/* Header: badge trạng thái + badge cố định */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusBadge label={statusLabel} className={statusStyle} />
            {bankStatus === 'APPROVED' ? (
              <StatusBadge label="Cố định giải ngân" className="bg-[#EEF2FF] text-[#4338CA]" />
            ) : null}
          </div>
          {submittedAtLabel ? (
            <span className="text-xs text-[#9CA3AF]">
              Nộp lần cuối: {submittedAtLabel}
            </span>
          ) : null}
        </div>

        {/* Thông báo lý do từ chối */}
        {bankStatus === 'REJECTED' && latestOrganizationKycSubmission?.rejectionReason ? (
          <div className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-xs text-[#991B1B]">
            <span className="mr-1 font-semibold">Lý do từ chối:</span>
            {latestOrganizationKycSubmission.rejectionReason}
          </div>
        ) : null}

        {/* Thông báo cảnh báo khi chưa liên kết */}
        {bankStatus === null && !isOrganizationKycLoading ? (
          <div className="rounded-lg border border-[#FEF9C3] bg-[#FEFCE8] px-3 py-2.5 text-xs text-[#854D0E]">
            Tổ chức chưa liên kết tài khoản ngân hàng. Hãy điền thông tin thật chính xác và cẩn thận bên dưới để bắt đầu nhận giải ngân.
          </div>
        ) : null}

        {/* Thông báo đang chờ duyệt */}
        {bankStatus === 'PENDING_REVIEW' ? (
          <div className="rounded-lg border border-[#FEF3C7] bg-[#FFFBEB] px-3 py-2.5 text-xs text-[#92400E]">
            Hồ sơ đang chờ regulatory xác minh. Bạn sẽ nhận thông báo khi có kết quả duyệt.
          </div>
        ) : null}

        {/* Chi tiết tài khoản đã duyệt */}
        {bankStatus === 'APPROVED' && latestOrganizationKycSubmission?.beneficiaryBankAccount ? (
          <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] overflow-hidden">
            {/* Header của card chi tiết */}
            <div className="flex items-center gap-2 px-4 py-2.5 bg-[#DCFCE7] border-b border-[#BBF7D0]">
              <span className="text-sm">🏦</span>
              <span className="text-xs font-semibold text-[#166534]">Tài khoản thụ hưởng đã xác minh</span>
              <span className="ml-auto text-xs text-[#16A34A]">✓ Xác nhận</span>
            </div>
            {/* Body: 2 cột */}
            <div className="grid grid-cols-1 divide-y divide-[#D1FAE5] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3 space-y-3">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-[#6B7280] mb-0.5">Ngân hàng</p>
                  <p className="text-sm font-semibold text-[#111827]">{latestOrganizationKycSubmission.beneficiaryBankAccount.bankName}</p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-[#6B7280] mb-0.5">Chi nhánh</p>
                  <p className="text-sm font-medium text-[#374151]">
                    {latestOrganizationKycSubmission.beneficiaryBankAccount.branchName || '—'}
                  </p>
                </div>
              </div>
              <div className="px-4 py-3 space-y-3">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-[#6B7280] mb-0.5">Số tài khoản</p>
                  <p className="text-sm font-semibold text-[#111827] font-mono">
                    {latestOrganizationKycSubmission.beneficiaryBankAccount.bankAccountNumber}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-[#6B7280] mb-0.5">Tên chủ tài khoản</p>
                  <p className="text-sm font-semibold text-[#111827]">
                    {latestOrganizationKycSubmission.beneficiaryBankAccount.accountHolderName}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Dòng phân cách */}
      {(bankStatus === 'APPROVED' || bankStatus === 'REJECTED') && !isOrganizationKycLoading ? (
        <div className="mt-4 mb-3 border-t border-[#E5E7EB]" />
      ) : null}

      {/* Loading state */}
      {isOrganizationKycLoading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-[#6B7280]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#0E7C6B] border-t-transparent" />
          Đang tải trạng thái duyệt tài khoản...
        </div>
      ) : null}

      {/* Error state */}
      {organizationKycErrorMessage ? (
        <div className="mt-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3">
          <p className="text-xs text-[#991B1B]">{organizationKycErrorMessage}</p>
          <button
            type="button"
            onClick={() => { void Promise.resolve(onRetryLoadOrganizationKycSubmissions()); }}
            className="mt-2 rounded border border-[#FCA5A5] px-3 py-1 text-xs font-semibold text-[#991B1B] hover:bg-[#FEE2E2]"
          >
            Thử lại
          </button>
        </div>
      ) : null}

      {/* Success/Error messages từ form submit */}
      {bankSubmitSuccessMessage ? (
        <div className="mt-3 rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs text-[#166534]">
          {bankSubmitSuccessMessage}
        </div>
      ) : null}
      {bankSubmitErrorMessage ? (
        <div className="mt-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
          {bankSubmitErrorMessage}
        </div>
      ) : null}

      {/* Form liên kết tài khoản ngân hàng */}
      {shouldShowBankForm && !isOrganizationKycLoading ? (
        <div className="mt-4">
          <div className="rounded-xl border border-[#E6F7F4] bg-[#F9FDFC] p-4">
            <p className="mb-3 text-xs font-medium text-[#0E7C6B]">📝 Liên kết tài khoản ngân hàng</p>
            <div className="grid gap-3 text-sm">
              <select
                className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2.5 text-sm text-[#111827] focus:border-[#0E7C6B] focus:outline-none focus:ring-1 focus:ring-[#0E7C6B]"
                value={bankFormData.bankName}
                onChange={event => handleBankFieldChange('bankName', event.target.value)}
              >
                <option value="">-- Chọn ngân hàng --</option>
                {vietnameseBankNameOptions.map(bankNameOption => (
                  <option key={bankNameOption} value={bankNameOption}>{bankNameOption}</option>
                ))}
              </select>
              {bankFormErrors.bankName ? <p className="text-xs text-[#DC2626]">{bankFormErrors.bankName}</p> : null}

              <div>
                <input
                  className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder-[#9CA3AF] focus:border-[#0E7C6B] focus:outline-none focus:ring-1 focus:ring-[#0E7C6B]"
                  placeholder="Số tài khoản"
                  value={bankFormData.bankAccountNumber}
                  onChange={event => handleBankFieldChange('bankAccountNumber', event.target.value.replace(/[^0-9]/g, ''))}
                />
                {bankFormErrors.bankAccountNumber ? <p className="mt-1 text-xs text-[#DC2626]">{bankFormErrors.bankAccountNumber}</p> : null}
              </div>

              <div>
                <input
                  className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder-[#9CA3AF] focus:border-[#0E7C6B] focus:outline-none focus:ring-1 focus:ring-[#0E7C6B]"
                  placeholder="Tên chủ tài khoản"
                  value={bankFormData.accountHolderName}
                  onChange={event => handleBankFieldChange('accountHolderName', normalizeAccountHolderName(event.target.value))}
                />
                {bankFormErrors.accountHolderName ? <p className="mt-1 text-xs text-[#DC2626]">{bankFormErrors.accountHolderName}</p> : null}
              </div>

              <input
                className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder-[#9CA3AF] focus:border-[#0E7C6B] focus:outline-none focus:ring-1 focus:ring-[#0E7C6B]"
                placeholder="Chi nhánh (không bắt buộc)"
                value={bankFormData.branchName}
                onChange={event => handleBankFieldChange('branchName', event.target.value)}
              />

              <button
                type="button"
                onClick={handleSubmitBeneficiaryBankAccount}
                disabled={isSubmittingBankForm || isOrganizationKycLoading}
                className="w-full rounded-lg bg-[#0E7C6B] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0A5C50] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmittingBankForm ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Đang gửi duyệt...
                  </span>
                ) : 'Gửi duyệt tài khoản'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

/** Hàm render section Settings. Mục đích: hiển thị điều hướng cài đặt và cho phép nộp thông tin ngân hàng thụ hưởng thật. */
type SettingsSectionProps = {
  isBankSetupHighlighted: boolean;
  isOrganizationKycLoading: boolean;
  organizationKycErrorMessage: string | null;
  onRetryLoadOrganizationKycSubmissions: () => Promise<void> | void;
  onBankSubmissionSuccess: () => Promise<void> | void;
  organizationKycSubmissionList: Array<{
    submissionId: string;
    organizationId: string;
    organizationName: string;
    legalRegistrationNumber: string;
    status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUBMISSION_ERROR';
    submittedAt: string;
    reviewedAt: string | null;
    rejectionReason?: string | null;
    beneficiaryBankAccount?: {
      bankName: string;
      bankAccountNumber: string;
      accountHolderName: string;
      branchName: string | null;
    } | null;
  }>;
};

type BeneficiaryBankAccountFormData = {
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName: string;
};

type BeneficiaryBankAccountFormErrors = Partial<Record<keyof BeneficiaryBankAccountFormData, string>>;

type SecuritySessionsResponseData = {
  sessions?: ActiveSessionItem[];
};

type OrganizationProfileResponseData = {
  profile?: OrganizationProfileItem | null;
};


export function SettingsSection({
  isBankSetupHighlighted,
  isOrganizationKycLoading,
  organizationKycErrorMessage,
  onRetryLoadOrganizationKycSubmissions,
  organizationKycSubmissionList = [],
  onBankSubmissionSuccess
}: SettingsSectionProps) {
  const [activeSettingsTab, setActiveSettingsTab] = useState<'organization' | 'bank' | 'security'>('organization');
  const [bankFormData, setBankFormData] = useState<BeneficiaryBankAccountFormData>({
    bankName: '',
    bankAccountNumber: '',
    accountHolderName: '',
    branchName: ''
  });
  const [bankFormErrors, setBankFormErrors] = useState<BeneficiaryBankAccountFormErrors>({});
  const [bankSubmitErrorMessage, setBankSubmitErrorMessage] = useState<string | null>(null);
  const [bankSubmitSuccessMessage, setBankSubmitSuccessMessage] = useState<string | null>(null);
  const [isSubmittingBankForm, setIsSubmittingBankForm] = useState(false);
  const [activeSessionList, setActiveSessionList] = useState<ActiveSessionItem[]>([]);
  const [isSecuritySessionsLoading, setIsSecuritySessionsLoading] = useState(false);
  const [securitySessionsErrorMessage, setSecuritySessionsErrorMessage] = useState<string | null>(null);
  const [organizationProfileData, setOrganizationProfileData] = useState<OrganizationProfileItem | null>(null);
  const [isOrganizationProfileLoading, setIsOrganizationProfileLoading] = useState(false);
  const [organizationProfileErrorMessage, setOrganizationProfileErrorMessage] = useState<string | null>(null);

  /** Hàm tải danh sách phiên đăng nhập cho tab bảo mật. Mục đích: lấy dữ liệu thật từ backend và đồng bộ state UI. */
  const loadSecuritySessions = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setSecuritySessionsErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      setActiveSessionList([]);
      return;
    }

    setIsSecuritySessionsLoading(true);
    setSecuritySessionsErrorMessage(null);

    try {
      const response = await fetchApi<SecuritySessionsResponseData>(buildApiUrl('/auth/sessions/me'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });
      const nextActiveSessionList = Array.isArray(response.data.sessions) ? response.data.sessions : [];
      setActiveSessionList(nextActiveSessionList);
    } catch (error: unknown) {
      setSecuritySessionsErrorMessage(resolveSecuritySessionErrorMessage(error));
      setActiveSessionList([]);
    } finally {
      setIsSecuritySessionsLoading(false);
    }
  };

  /** Hàm tải profile tổ chức cho tab cài đặt. Mục đích: lấy dữ liệu thật của tổ chức hiện tại từ backend. */
  const loadOrganizationProfile = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setOrganizationProfileErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      setOrganizationProfileData(null);
      return;
    }

    setIsOrganizationProfileLoading(true);
    setOrganizationProfileErrorMessage(null);

    try {
      const response = await fetchApi<OrganizationProfileResponseData>(buildApiUrl('/auth/organization/profile/me'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });

      setOrganizationProfileData(response.data.profile || null);
    } catch (error: unknown) {
      setOrganizationProfileErrorMessage(resolveOrganizationProfileErrorMessage(error));
      setOrganizationProfileData(null);
    } finally {
      setIsOrganizationProfileLoading(false);
    }
  };

  /** Hàm chọn tab cài đặt. Mục đích: cập nhật nội dung panel theo mục người dùng chọn. */
  const handleSelectSettingsTab = (tab: 'organization' | 'bank' | 'security') => {
    setActiveSettingsTab(tab);
  };

  /**
   * Hàm lấy hồ sơ bank account mới nhất. Mục đích: chỉ chọn submission chứa dữ liệu tài khoản ngân hàng thực sự,
   * tránh nhầm lẫn với KYC profile submission (là hai loại submission khác nhau về nghiệp vụ).
   */
  const latestOrganizationKycSubmission = useMemo(() => {
    const safeOrganizationKycSubmissionList = Array.isArray(organizationKycSubmissionList) ? organizationKycSubmissionList : [];

    // Logic này chỉ lọc submission có dữ liệu bank account thực sự, loại trừ KYC profile submission.
    const submissionListWithBankAccount = safeOrganizationKycSubmissionList
      .filter(submissionItem => submissionItem.beneficiaryBankAccount !== null);

    if (!submissionListWithBankAccount.length) {
      return null;
    }

    const submissionListByLatest = [...submissionListWithBankAccount].sort((leftSubmission, rightSubmission) => {
      return new Date(rightSubmission.submittedAt).getTime() - new Date(leftSubmission.submittedAt).getTime();
    });

    return submissionListByLatest[0];
  }, [organizationKycSubmissionList]);

  const isOrganizationTabActive = activeSettingsTab === 'organization';
  const isBankTabActive = activeSettingsTab === 'bank';
  const isSecurityTabActive = activeSettingsTab === 'security';

  /** Hàm tự động tải profile tổ chức khi người dùng mở tab Tổ chức. Mục đích: đảm bảo luôn hiển thị dữ liệu thật mới nhất. */
  useEffect(() => {
    if (!isOrganizationTabActive) {
      return;
    }

    void loadOrganizationProfile();
  }, [isOrganizationTabActive]);

  /** Hàm tự động tải phiên bảo mật khi người dùng mở tab Security. Mục đích: đảm bảo dữ liệu luôn là dữ liệu thật mới nhất từ backend. */
  useEffect(() => {
    if (!isSecurityTabActive) {
      return;
    }

    void loadSecuritySessions();
  }, [isSecurityTabActive]);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[220px_1fr]">
      <div className="rounded-[14px] border border-[#E5E7EB] bg-white p-2 text-sm">
        <button type="button" onClick={() => handleSelectSettingsTab('organization')} className={`w-full rounded px-3 py-2 text-left ${isOrganizationTabActive ? 'bg-[#F2FBFA] text-[#0E7C6B]' : ''}`}>🏢 Tổ chức</button>
        <button type="button" onClick={() => handleSelectSettingsTab('bank')} className={`mt-1 w-full rounded px-3 py-2 text-left ${isBankTabActive ? 'bg-[#F2FBFA] text-[#0E7C6B]' : ''}`}>🏦 Ngân hàng</button>
        <button type="button" onClick={() => handleSelectSettingsTab('security')} className={`mt-1 w-full rounded px-3 py-2 text-left ${isSecurityTabActive ? 'bg-[#F2FBFA] text-[#0E7C6B]' : ''}`}>🔐 Bảo mật</button>
      </div>

      <div className="space-y-4">
        {isOrganizationTabActive ? (
          <SectionCard title="Thiết lập tổ chức">
            <div className="space-y-3 text-sm">
              {isOrganizationProfileLoading ? <p className="text-sm text-[#6B7280]">Đang tải dữ liệu tổ chức...</p> : null}

              {!isOrganizationProfileLoading && organizationProfileErrorMessage ? (
                <div className="rounded border border-[#FECACA] bg-[#FEF2F2] p-3 text-sm">
                  <p className="text-[#991B1B]">{organizationProfileErrorMessage}</p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadOrganizationProfile();
                    }}
                    className="mt-2 rounded border border-[#FCA5A5] px-3 py-1 text-xs font-semibold text-[#991B1B]"
                  >
                    Thử lại
                  </button>
                </div>
              ) : null}

              {!isOrganizationProfileLoading && !organizationProfileErrorMessage && !organizationProfileData ? (
                <p className="text-sm text-[#6B7280]">Chưa có thông tin tổ chức.</p>
              ) : null}

              {!isOrganizationProfileLoading && !organizationProfileErrorMessage && organizationProfileData ? (
                <div className="grid gap-3 text-sm">
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#6B7280]">Tên tổ chức</p>
                    <input
                      className="w-full rounded border border-[#D1D5DB] px-3 py-2"
                      value={organizationProfileData.organizationName}
                      readOnly
                    />
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#6B7280]">Mã đăng ký pháp lý</p>
                    <input
                      className="w-full rounded border border-[#D1D5DB] px-3 py-2"
                      value={organizationProfileData.legalRegistrationNumber}
                      readOnly
                    />
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#6B7280]">Website chính thức</p>
                    <input
                      className="w-full rounded border border-[#D1D5DB] px-3 py-2"
                      value={organizationProfileData.officialWebsite || 'Chưa cập nhật'}
                      readOnly
                    />
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#6B7280]">Mô tả tổ chức</p>
                    <textarea
                      className="min-h-[100px] w-full rounded border border-[#D1D5DB] px-3 py-2"
                      value={organizationProfileData.organizationDescription || 'Chưa cập nhật'}
                      readOnly
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        {isBankTabActive ? (
          <BankSettingsPanel
            isBankSetupHighlighted={isBankSetupHighlighted}
            isOrganizationKycLoading={isOrganizationKycLoading}
            organizationKycErrorMessage={organizationKycErrorMessage}
            onRetryLoadOrganizationKycSubmissions={onRetryLoadOrganizationKycSubmissions}
            latestOrganizationKycSubmission={latestOrganizationKycSubmission}
            bankFormData={bankFormData}
            bankFormErrors={bankFormErrors}
            bankSubmitErrorMessage={bankSubmitErrorMessage}
            isSubmittingBankForm={isSubmittingBankForm}
            bankSubmitSuccessMessage={bankSubmitSuccessMessage}
            onBankFormDataChange={setBankFormData}
            onBankFormErrorsChange={setBankFormErrors}
            onBankSubmitErrorMessageChange={setBankSubmitErrorMessage}
            onBankSubmitSuccessMessageChange={setBankSubmitSuccessMessage}
            onSubmittingBankFormChange={setIsSubmittingBankForm}
            onBankSubmissionSuccess={onBankSubmissionSuccess}
          />
        ) : null}

        {isSecurityTabActive ? (
          <SectionCard title="Thiết lập bảo mật">
            <div className="space-y-3 text-sm">
              {isSecuritySessionsLoading ? <p className="text-sm text-[#6B7280]">Đang tải phiên hoạt động...</p> : null}

              {!isSecuritySessionsLoading && securitySessionsErrorMessage ? (
                <div className="rounded border border-[#FECACA] bg-[#FEF2F2] p-3 text-sm">
                  <p className="text-[#991B1B]">{securitySessionsErrorMessage}</p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadSecuritySessions();
                    }}
                    className="mt-2 rounded border border-[#FCA5A5] px-3 py-1 text-xs font-semibold text-[#991B1B]"
                  >
                    Thử lại
                  </button>
                </div>
              ) : null}

              {!isSecuritySessionsLoading && !securitySessionsErrorMessage && !activeSessionList.length ? (
                <p className="text-sm text-[#6B7280]">Chưa có phiên hoạt động.</p>
              ) : null}

              {!isSecuritySessionsLoading && !securitySessionsErrorMessage && activeSessionList.length ? (
                <div className="space-y-3">
                  {activeSessionList.map(activeSessionItem => (
                    <div key={activeSessionItem.sessionId} className="rounded border border-[#E5E7EB] p-3">
                      <p className="font-medium">{activeSessionItem.deviceLabel}</p>
                      <p className="mt-1 text-xs text-[#6B7280]">Lần cuối: {formatSecurityDateTime(activeSessionItem.lastActiveAt)}</p>
                      <p className="mt-1 text-xs text-[#6B7280]">Đăng nhập lúc: {formatSecurityDateTime(activeSessionItem.loggedInAt)}</p>
                      <p className="mt-1 text-xs text-[#9CA3AF]">IP: {activeSessionItem.ipAddress || 'Không xác định'}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}

/** Hàm render modal tạo dự án. Mục đích: quản lý form, upload file minh chứng và tạo dự án qua API thật. */
export function CreateProjectModal({ onClose, onProjectCreated }: CreateProjectModalProps) {
  const [formData, setFormData] = useState<CreateProjectFormData>(createProjectDefaultFormState);
  const [selectedEvidenceFiles, setSelectedEvidenceFiles] = useState<File[]>([]);
  const [formErrors, setFormErrors] = useState<CreateProjectFormErrors>({});
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const milestonePlanFeedback = buildMilestonePlanFeedback(formData);

  /** Khóa cuộn nền khi modal mở và khôi phục đúng trạng thái trước đó khi modal đóng. */
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  /** Hàm cập nhật input theo field. Mục đích: gom logic controlled input và xóa lỗi field ngay khi người dùng chỉnh sửa. */
  const handleChangeFormField = (field: Exclude<keyof CreateProjectFormData, 'milestonePlan'>, value: string) => {
    const nextFormData: CreateProjectFormData = { ...formData, [field]: value };
    setFormData(nextFormData);
    const nextFormErrors = validateCreateProjectFormData(nextFormData, selectedEvidenceFiles);
    setFormErrors(currentErrors => ({ ...currentErrors, [field]: nextFormErrors[field] }));
  };

  /** Cập nhật một ô kế hoạch cột mốc và kiểm tra lại tổng phần trăm ngay trên form. */
  const handleChangeMilestone = (index: number, field: 'percentage' | 'description', value: string): void => {
    const milestonePlan = formData.milestonePlan.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item);
    const nextFormData = { ...formData, milestonePlan };
    setFormData(nextFormData);
    const nextFormErrors = validateCreateProjectFormData(nextFormData, selectedEvidenceFiles);
    setFormErrors(currentErrors => {
      const updatedErrors = { ...currentErrors };

      if (nextFormErrors.milestonePlan) {
        updatedErrors.milestonePlan = nextFormErrors.milestonePlan;
      } else {
        delete updatedErrors.milestonePlan;
      }

      return updatedErrors;
    });
  };

  /** Hàm xử lý chọn file minh chứng. Mục đích: thêm file mới vào danh sách và validate giới hạn số lượng. */
  const handleSelectEvidenceFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) {
      return;
    }

    const nextSelectedEvidenceFiles = [...selectedEvidenceFiles, ...selectedFiles].slice(0, 10);
    setSelectedEvidenceFiles(nextSelectedEvidenceFiles);
    setFormErrors(currentErrors => ({ ...currentErrors, evidenceFiles: validateCreateProjectFormData(formData, nextSelectedEvidenceFiles).evidenceFiles }));
    event.target.value = '';
  };

  /** Hàm xóa file minh chứng đã chọn. Mục đích: cho phép người dùng chỉnh lại danh sách file trước khi submit. */
  const handleRemoveEvidenceFile = (fileIndex: number) => {
    const nextSelectedEvidenceFiles = selectedEvidenceFiles.filter((_, currentFileIndex) => currentFileIndex !== fileIndex);
    setSelectedEvidenceFiles(nextSelectedEvidenceFiles);
    setFormErrors(currentErrors => ({ ...currentErrors, evidenceFiles: validateCreateProjectFormData(formData, nextSelectedEvidenceFiles).evidenceFiles }));
  };

  /** Hàm upload file minh chứng. Mục đích: gửi file base64 lên backend để nhận CID IPFS từ Pinata. */
  const uploadEvidenceFiles = async (accessToken: string): Promise<UploadEvidenceResponse> => {
    const uploadPayloadFiles: UploadEvidenceFilePayload[] = await Promise.all(
      selectedEvidenceFiles.map(async fileItem => ({
        fileName: fileItem.name,
        mimeType: fileItem.type,
        contentBase64: await convertFileToBase64(fileItem)
      }))
    );

    const uploadResponse = await fetchApi<UploadEvidenceResponse>(buildApiUrl('/projects/evidences/upload'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ files: uploadPayloadFiles })
    });

    return uploadResponse.data;
  };

  /** Hàm submit tạo dự án. Mục đích: upload file lấy CID rồi gọi API tạo dự án. */
  const handleSubmitCreateProject = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const nextFormErrors = validateCreateProjectFormData(formData, selectedEvidenceFiles);

    if (Object.keys(nextFormErrors).length > 0) {
      setFormErrors(nextFormErrors);
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setSubmitErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setSubmitErrorMessage(null);
    setIsSubmitting(true);

    try {
      const uploadResult = await uploadEvidenceFiles(authSession.accessToken);
      const response = await fetchApi<ProjectSummary>(buildApiUrl('/projects'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          goalAmount: Number(formData.goalAmount),
          deadline: new Date(formData.deadline).toISOString(),
          milestonePlan: formData.milestonePlan.map((item, index) => ({
            milestoneIndex: index + 1,
            milestoneKey: ['M1_ADVANCE', 'M2_CONSTRUCTION', 'M3_HANDOVER'][index],
            percentage: Number(item.percentage),
            description: item.description.trim()
          })),
          evidenceCids: uploadResult.evidenceCids,
          evidenceFiles: uploadResult.evidenceFiles
        })
      });

      onProjectCreated(response.data);
      setFormData(createProjectDefaultFormState);
      setSelectedEvidenceFiles([]);
      setFormErrors({});
      onClose();
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể tạo dự án. Vui lòng thử lại sau.';
      if (error && typeof error === 'object') {
        const typedError = error as {
          details?: ApiErrorDetail[];
          errorCode?: string;
        };

        // Logic ưu tiên map theo errorCode để hiển thị đúng thông điệp nghiệp vụ từ backend.
        if (typedError.errorCode === 'BENEFICIARY_BANK_ACCOUNT_NOT_APPROVED') {
          setSubmitErrorMessage('Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt để thiết lập ngân hàng.');
          return;
        }

        if (Array.isArray(typedError.details)) {
          setFormErrors(mapApiDetailsToFormErrors(typedError.details));
        }

        setSubmitErrorMessage(resolveApiErrorMessage(error, fallbackErrorMessage));
      } else {
        setSubmitErrorMessage(fallbackErrorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:p-4">
      <div
        className="my-2 flex max-h-[calc(100vh-1rem)] w-full max-w-[640px] flex-col overflow-hidden rounded-[18px] bg-white shadow-2xl sm:my-4 sm:max-h-[calc(100vh-2rem)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-modal-title"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#F3F4F6] p-4 sm:p-5">
          <div className="min-w-0">
            <p className="mb-1 text-2xl">🚀</p>
            <p id="create-project-modal-title" className="text-lg font-bold">Tạo dự án mới</p>
            <p className="text-xs text-[#6B7280]">Điền thông tin theo 2 bước để khởi tạo dự án minh bạch.</p>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 shrink-0 rounded-full bg-[#F3F4F6]" aria-label="Đóng modal tạo dự án">✕</button>
        </div>

        <form className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 text-sm sm:p-5" onSubmit={handleSubmitCreateProject}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <input className="w-full rounded border border-[#D1D5DB] px-3 py-2" placeholder="Tên dự án *" value={formData.name} onChange={event => handleChangeFormField('name', event.target.value)} />
              {formErrors.name ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.name}</p> : null}
            </div>
            <div className="md:col-span-2">
              <textarea className="min-h-[86px] w-full rounded border border-[#D1D5DB] px-3 py-2" placeholder="Mô tả ngắn" value={formData.description} onChange={event => handleChangeFormField('description', event.target.value)} />
              {formErrors.description ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.description}</p> : null}
            </div>
            <div className="min-w-0">
              <input className="w-full rounded border border-[#D1D5DB] px-3 py-2" placeholder="Mục tiêu gây quỹ (VNĐ)" value={formData.goalAmount} onChange={event => handleChangeFormField('goalAmount', event.target.value)} />
              {formErrors.goalAmount ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.goalAmount}</p> : null}
            </div>
            <div className="min-w-0">
              <label htmlFor="create-project-deadline" className="mb-1 block text-xs font-semibold text-[#374151]">Chọn thời điểm kết thúc</label>
              <input id="create-project-deadline" type="datetime-local" className="w-full min-w-0 rounded border border-[#D1D5DB] px-3 py-2" value={formData.deadline} onChange={event => handleChangeFormField('deadline', event.target.value)} />
              {formErrors.deadline ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.deadline}</p> : null}
            </div>
            <div className="md:col-span-2 rounded border border-[#CCFBF1] bg-[#F0FDFA] p-3">
              <p className="font-semibold text-[#0F766E]">Kế hoạch cột mốc giải ngân</p>
              {(['M1 · Tạm ứng khởi động (≤25%)', 'M2 · Thi công', 'M3 · Nghiệm thu bàn giao'] as const).map((label, index) => (
                <div key={label} className="mt-2 grid min-w-0 gap-2 md:grid-cols-[180px_100px_minmax(0,1fr)]">
                  <label className="self-center text-xs font-medium">{label}</label>
                  <input inputMode="numeric" placeholder="%" value={formData.milestonePlan[index].percentage} onChange={event => handleChangeMilestone(index, 'percentage', event.target.value)} className="min-w-0 rounded border border-[#99F6E4] px-2 py-1" />
                  <input placeholder="Mô tả hạng mục (10–500 ký tự)" value={formData.milestonePlan[index].description} onChange={event => handleChangeMilestone(index, 'description', event.target.value)} className="min-w-0 rounded border border-[#99F6E4] px-2 py-1" />
                </div>
              ))}
              {milestonePlanFeedback.hasInput && milestonePlanFeedback.totalPercentage !== 100 ? (
                <p className="mt-2 text-xs font-semibold text-[#DC2626]" role="status">
                  Tổng phân bổ: {milestonePlanFeedback.totalPercentage}% · {milestonePlanFeedback.totalPercentage < 100 ? `Còn thiếu ${100 - milestonePlanFeedback.totalPercentage}%` : `Đang vượt ${milestonePlanFeedback.totalPercentage - 100}%`}
                </p>
              ) : null}
              {formErrors.milestonePlan && formErrors.milestonePlan !== TOTAL_MILESTONE_ERROR_MESSAGE ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.milestonePlan}</p> : null}
            </div>
            <div className="md:col-span-2">
              <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.docx" onChange={handleSelectEvidenceFiles} className="w-full rounded border border-[#D1D5DB] px-3 py-2" />
              <p className="mt-1 text-xs text-[#6B7280]">Tối đa 10 file: PDF, PNG, JPG, JPEG, DOCX.</p>
              <p className="mt-1 text-xs font-semibold text-[#D97706]">Lưu ý: Tấm ảnh đầu tiên sẽ được lấy làm ảnh bìa dự án.</p>
              {formErrors.evidenceFiles ? <p className="mt-1 text-xs text-[#DC2626]">{formErrors.evidenceFiles}</p> : null}
              {selectedEvidenceFiles.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {selectedEvidenceFiles.map((fileItem, fileIndex) => (
                    <div key={`${fileItem.name}-${fileIndex}`} className="flex min-w-0 items-center justify-between gap-2 rounded border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-1 text-xs">
                      <span className="min-w-0 truncate">{fileItem.name}</span>
                      <button type="button" onClick={() => handleRemoveEvidenceFile(fileIndex)} className="shrink-0 text-[#DC2626]">Xóa</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {submitErrorMessage ? <p className="rounded border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">{submitErrorMessage}</p> : null}

          <div className="flex flex-col gap-2 border-t border-[#F3F4F6] pt-4 sm:flex-row">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="flex-1 rounded bg-[#F3F4F6] py-2 text-sm">Hủy</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 rounded bg-[#0E7C6B] py-2 text-sm font-semibold text-white disabled:opacity-60">{isSubmitting ? 'Đang tạo...' : 'Tạo dự án'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
