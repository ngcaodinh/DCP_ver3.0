export type OrganizationPageKey = 'dashboard' | 'projects' | 'disbursement' | 'transparency' | 'settings';

export type NavigationItem = {
  icon: string;
  label: string;
  page?: OrganizationPageKey;
  badge?: string;
  action?: 'createProject';
};

export type StatisticItem = {
  color: 'emerald' | 'blue' | 'amber' | 'gold';
  icon: string;
  label: string;
  value: string;
  subtitle: string;
  change: string;
  changeStyle?: 'up' | 'warn';
};

export type ProjectItem = {
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
};

export type TimelineItem = {
  dotStyle: string;
  content: string;
  time: string;
};

export type DashboardFeaturedProject = {
  projectId: string;
  name: string;
  description: string;
  raisedAmount: number;
  goalAmount: number;
  progressPercent: number;
};

export type DashboardDonationHistoryItem = {
  transactionHash: string;
  projectName: string;
  donorLabel: string;
  amount: number;
  timestamp: string;
  timestampIso: string;
};

export type TransactionRow = {
  time: string;
  type: string;
  amount: string;
  sender: string;
  hash: string;
  status: string;
  typeStyle: string;
  statusStyle: string;
};

export type ProjectSummaryStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'REJECTED';

export type ProjectSummary = {
  projectId: string;
  organizationId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline: string;
  status: ProjectSummaryStatus;
  evidenceCids: string[];
  evidenceFiles?: { cid: string; fileName: string; mimeType: string }[];
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
};
export type DisbursementStatus = 'PENDING' | 'APPROVED' | 'EXECUTING' | 'REJECTED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export type DisbursementRequestMode = 'NORMAL' | 'EMERGENCY';

export type DisbursementTransferStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'MANUAL_REVIEW';

export type DisbursementResult = {
  requestId: string;
  onChainRequestId: number;
  projectId: string;
  beneficiaryWalletAddress: string;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
  requestMode: DisbursementRequestMode;
  emergencyReason: string | null;
  requiredApprovals: number;
  raisedRatioBpsAtCreation: number;
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  status: DisbursementStatus;
  approvals: Array<{
    signerRole: string;
    signerUserId: string;
    signerAddress: string;
    signedAt: string;
    comment?: string;
  }>;
  rejection: {
    signerRole: string;
    signerUserId: string;
    signerAddress: string;
    reason: string;
    rejectedAt: string;
  } | null;
  timeoutDeadline: string | null;
  payosTransferId: string | null;
  payosTransferStatus: DisbursementTransferStatus | null;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  completedAt: string | null;
};
