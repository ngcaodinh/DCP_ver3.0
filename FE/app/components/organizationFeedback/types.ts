export const ORGANIZATION_ROLE_VALUES = ['organizations', 'organization'] as const;
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH_ROWS = 1000;
export const UPLOAD_RATE_PER_MINUTE = 10;
export const EXPORT_MAX_ROWS = 2000;
export const EXPORT_PAGE_LIMIT = 100;

export type OrganizationRole = typeof ORGANIZATION_ROLE_VALUES[number];
export type ModerationState = 'all' | 'visible' | 'pending';
export type FeedbackSource = 'batch' | 'public';

export interface OrganizationFeedbackItem {
  feedbackId: string;
  projectId: string;
  projectName: string | null;
  rating: number;
  comment: string;
  submittedAt: string;
  location?: string;
  source: FeedbackSource;
  isFlagged: boolean;
}

export interface OrganizationFeedbackStats {
  totalCount: number;
  visibleCount: number;
  pendingCount: number;
  avgRating: number | null;
  distribution: Record<string, number>;
}

export interface OrganizationFeedbackListResponse {
  items: OrganizationFeedbackItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  stats: OrganizationFeedbackStats;
}

export interface OrganizationProjectOption {
  projectId: string;
  name: string;
}

export interface CsvPreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  fieldErrors: Record<string, string[]>;
  rowErrors: string[];
  rowWarnings: string[];
}

export interface CsvPreviewResult {
  headers: string[];
  rows: CsvPreviewRow[];
  totalRows: number;
  fileErrors: string[];
}

export interface BatchUploadError {
  rowNumber: number;
  reason: string;
}

export interface BatchUploadResult {
  success: number;
  failed: number;
  errors: BatchUploadError[];
  flaggedCount?: number;
  inputType?: 'csv' | 'json';
  isDuplicate?: boolean;
}
