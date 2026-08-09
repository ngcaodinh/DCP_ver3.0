export type TransferRequestMode = 'NORMAL' | 'EMERGENCY';

export type ManualReviewTransferStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'MANUAL_REVIEW';

export interface ManualReviewQueueItem {
  queueId: string;
  requestId: string;
  projectId: string;
  organizationId: string;
  amount: number;
  requestMode: TransferRequestMode;
  emergencyReason: string | null;
  payosTransferStatus: ManualReviewTransferStatus | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  reviewCycle: number;
  assignedAdminId: string | null;
  assignmentMethod: 'PROJECT_AFFINITY' | 'ROUND_ROBIN' | 'LEAST_LOADED' | 'UNASSIGNED';
  slaDeadline: string;
  escalatedAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** BE chưa persist nextRetryAt; A4 chỉ dùng SLA snapshot từ server. */
  nextRetryAt: null;
}

export interface ManualReviewQueuePage {
  items: ManualReviewQueueItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ManualReviewQueueCounts {
  all: number;
  emergency: number;
  normal: number;
  overdue: number;
}

export interface ManualReviewQueueParams {
  page: number;
  limit: number;
  requestMode?: TransferRequestMode;
  overdueOnly?: boolean;
}

export type ManualReviewQueueErrorKind =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'SERVER';

export interface ManualReviewQueueError extends Error {
  kind: ManualReviewQueueErrorKind;
  statusCode?: number;
  errorCode?: string;
}
