// =============================================================================
// Types cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/types.ts
// Mục đích: Định nghĩa các kiểu dữ liệu dùng chung cho trang Admin
// =============================================================================

/** Các trang/chức năng chính trong Admin panel. */
export type PageKey =
  | 'dashboard'
  | 'projectReview'
  | 'disbursement'
  | 'kyc'
  | 'bankAccountApproval'
  | 'systemErrorLog'
  | 'report'
  | 'transparency'
  | 'sybilManagement'
  | 'transferQueue';

/** Mục điều hướng trong Sidebar. */
export type NavigationItem = {
  key: PageKey;
  label: string;
  iconPath: string;         // SVG path string cho icon
  badge?: number;          // Số thông báo chờ xử lý
};

/** Item hiển thị trong bảng yêu cầu khẩn cấp. */
export type UrgentRequestItem = {
  id: string;
  projectName: string;
  organizationName: string;
  amountText: string;
  signatureState: string;
  deadlineText: string;
  deadlineLevel: 'urgent' | 'normal' | 'ok';
  ipfsCid?: string;
  fileName?: string;
  usagePurpose?: string;
};

/** Một dòng trong bảng audit log. */
export type AuditLogItem = {
  transactionId: string;
  requestId: string;
  amountText: string;
  statusText: string;
  actorText: string;
  timeText: string;
};

/** Một sự kiện trong timeline hoạt động. */
export type TimelineItem = {
  id?: string;
  type: 'sign' | 'view' | 'reject' | 'login';
  actionText: string;
  detailText: string;
  timeText: string;
};

/** Một thông báo toast. */
export type ToastItem = {
  id: string;
  titleText: string;
  bodyText: string;
  tone: 'success' | 'error' | 'warning' | 'info';
};

/** Nhóm lỗi hiển thị trong bảng log lỗi hệ thống. */
export type SystemErrorLogCategory =
  | 'TRANSFER_TIMEOUT_15_MINUTES'
  | 'DEPOSIT'
  | 'DISBURSEMENT'
  | 'AUTH';

/** Bộ lọc trạng thái đọc cho log lỗi hệ thống. */
export type SystemErrorLogReadStateFilter = 'all' | 'read' | 'unread';

/** Mức độ nghiêm trọng của log lỗi hệ thống. */
export type SystemErrorLogSeverityLevel = 'high' | 'medium' | 'low';

/** Thông tin actor gây ra lỗi để Admin truy vết chính xác. */
export type SystemErrorLogActorInfo = {
  displayName: string;
  userId: string | null;
  email: string | null;
  role: string | null;
  walletAddress: string | null;
};

/** Context chi tiết của log lỗi hệ thống phục vụ quản trị vận hành. */
export type SystemErrorLogDetailContext = {
  sourceOrigin: string;
  actor: SystemErrorLogActorInfo;
  ipAddress: string | null;
  userAgent: string | null;
  businessTimestamp: string | null;
  systemTimestamp: string;
  createdAt: string | null;
  updatedAt: string | null;
  correlationId: string | null;
  eventType: string | null;
  projectId: string | null;
  projectName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  orderCode: string | null;
  requestId: string | null;
  payosTransactionId: string | null;
  payosTransferId: string | null;
  payosTransferStatus: string | null;
  transferAttemptCount: number | null;
  amountVnd: number | null;
  amountToken: number | null;
};

/** Một dòng log lỗi hệ thống dành cho Admin. */
export type SystemErrorLogItem = {
  id: string;
  timestamp: string;
  category: SystemErrorLogCategory;
  categoryLabel: string;
  sourceModule: 'DEPOSIT' | 'DISBURSEMENT' | 'AUTH';
  severityLevel: SystemErrorLogSeverityLevel;
  title: string;
  details: string;
  referenceCode: string;
  isTransferTimeout15Minutes: boolean;
  detailContext: SystemErrorLogDetailContext;
  isRead: boolean;
  readAt: string | null;
};

/** Dữ liệu thống kê theo nhóm lỗi để hiển thị filter badge. */
export type SystemErrorLogCategorySummary = {
  category: SystemErrorLogCategory;
  categoryLabel: string;
  totalCount: number;
  unreadCount: number;
};

/** Các tab trong Request Drawer. */
export type DrawerTabKey = 'overview' | 'evidence' | 'signature' | 'history';

/** Mức độ rủi ro Sybil. */
export type SybilRiskLevel = 'critical' | 'high' | 'medium' | 'low';

/** Yếu tố rủi ro của một ví Sybil. */
export type SybilRiskFactor = {
  factorKey: string;
  factorName: string;
  score: number;
  maxScore: number;
};

/** Lịch sử donation của một ví. */
export type UserDonationHistory = {
  donationId: string;
  projectName: string;
  amount: number;
  timestamp: string;
  txHash: string;
  ipAddress: string;
};

/** Thông tin một user trong danh sách Sybil. */
export type SybilUser = {
  userId: string;
  walletAddress: string;
  displayName: string;
  email: string;
  role: string;
  isSybil: boolean;
  totalRiskScore: number;
  riskLevel: SybilRiskLevel;
  riskFactors: SybilRiskFactor[];
  donationCount: number;
  totalDonationAmount: number;
  ipAddresses: string[];
  deviceFingerprint?: string;
  firstActivity: string;
  lastActivity: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  donationHistory?: UserDonationHistory[];
};

/** Payload gửi lên API toggle Sybil status. */
export type SybilTogglePayload = {
  userId: string;
  walletAddress: string;
  action: 'mark' | 'unmark';
  reason: string;
  reviewedBy?: string;
};

/** Kết quả trả về từ API toggle Sybil. */
export type SybilToggleResult = {
  success: boolean;
  message: string;
  timestamp?: string;
};


