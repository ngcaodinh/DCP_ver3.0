/** Kiểu trạng thái của một bản ghi SBT mint trong dead-letter queue. */
export type SbtDlqStatus = 'OPEN' | 'RECOVERED' | 'ABANDONED';

/** Một bản ghi DLQ được trả về cho trang quản trị SBT retry. */
export interface SbtMintDlqEntry {
  dlqId: string;
  mintRequestId: string;
  sbtId: string;
  projectId: string;
  projectName: string | null;
  organizationId: string;
  beneficiaryAddress: string;
  attemptNumber: number;
  lastErrorMessage: string;
  firstAttemptedAt: string;
  dlqAt: string;
  recoveredAt: string | null;
  recoveredBy: string | null;
  recoveryAttemptNumber: number;
  lastRecoveryError?: string | null;
  lastRecoveryAt?: string | null;
  status: SbtDlqStatus;
  createdAt: string;
  updatedAt: string;
  _id?: string;
  __v?: number;
}

/** Metadata phân trang đi kèm danh sách DLQ. */
export interface SbtDlqPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  nextCursor?: string | null;
}

/** Payload data của API GET /api/sbt/dlq. */
export interface SbtDlqListResponse {
  entries: SbtMintDlqEntry[];
  pagination: SbtDlqPagination;
  openCount: number;
}

/** Kết quả API reset và enqueue lại một SBT mint job. */
export interface SbtRetryJobResult {
  mintRequestId: string;
  sbtId: string;
  status: string;
  attemptNumber: number;
  enqueued: boolean;
  jobId?: string | number;
}

/** Nhóm lỗi để UI quyết định retry, redirect hoặc thông báo phù hợp. */
export type SbtDlqErrorKind =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'NETWORK'
  | 'SERVER';

/** Lỗi đã chuẩn hóa từ API DLQ hoặc lỗi kết nối. */
export interface SbtDlqError extends Error {
  kind: SbtDlqErrorKind;
  statusCode?: number;
  errorCode?: string;
}
