export type PageKey = 'dashboard' | 'projectReview' | 'disbursement' | 'kyc' | 'bankAccountApproval' | 'report' | 'transparency' | 'sybilManagement';

export type NavigationItem = {
  key: PageKey;
  label: string;
  badge?: number;
  iconPath: string;
};

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

export type AuditLogItem = {
  transactionId: string;
  requestId: string;
  amountText: string;
  statusText: string;
  actorText: string;
  timeText: string;
};

export type TimelineItem = {
  actionText: string;
  detailText: string;
  timeText: string;
  type: 'sign' | 'view' | 'reject' | 'login';
};

export type ToastItem = {
  id: string;
  titleText: string;
  bodyText: string;
  tone: 'success' | 'error' | 'info';
};

export type DrawerTabKey = 'overview' | 'evidence' | 'signature' | 'history';

/** Kiểu mức độ rủi ro Sybil. */
export type SybilRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Kiểu yếu tố rủi ro Sybil — phản ánh 5 tiêu chí phát hiện trong document.md. */
export type SybilRiskFactor = {
  factorName: string;
  factorKey: 'ipCorrelation' | 'timePattern' | 'amountPattern' | 'deviceFingerprint' | 'socialVerification';
  score: number;
  maxScore: number;
  description: string;
};

/** Kiểu lịch sử donation của một ví — dùng trong modal chi tiết Sybil. */
export type UserDonationHistory = {
  donationId: string;
  projectId: string;
  projectName: string;
  amount: number;
  amountText: string;
  timestamp: string;
  txHash: string;
  walletAddress: string;
  isAnonymous: boolean;
  ipAddress: string;
};

/** Kiểu thông tin người dùng — hiển thị trong bảng quản lý Sybil. */
export type SybilUser = {
  userId: string;
  walletAddress: string;
  displayName: string;
  email: string;
  role: string;
  isSybil: boolean;
  riskLevel: SybilRiskLevel;
  totalRiskScore: number;
  totalDonationAmount: number;
  donationCount: number;
  firstActivity: string;
  lastActivity: string;
  ipAddresses: string[];
  deviceFingerprint: string | null;
  riskFactors: SybilRiskFactor[];
  /** donationHistory chỉ có khi xem chi tiết (từ /api/sybil/users/:userId), không có trong list endpoint. */
  donationHistory?: UserDonationHistory[];
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
};

/** Kiểu payload API để đánh dấu/bỏ đánh dấu Sybil. */
export type SybilTogglePayload = {
  userId: string;
  walletAddress: string;
  action: 'mark' | 'unmark';
  reason: string;
};

/** Kiểu kết quả toggle Sybil trả về từ API. */
export type SybilToggleResult = {
  success: boolean;
  message: string;
  userId: string;
  walletAddress: string;
  newIsSybilValue: boolean;
  updatedAt: string;
  updatedBy: string;
};


