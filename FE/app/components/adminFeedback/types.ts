/** Contract DTO của panel admin feedback, chỉ chứa field được BE allowlist. */
export const HIGH_RISK_HIGHLIGHT_THRESHOLD = 8;

export type DeletionState = 'active' | 'deleted';
export type FlagReasonKind = 'AUTO' | 'MANUAL' | 'UNKNOWN';
export type FeedbackActionMode = 'unflag' | 'delete' | 'restore';

export interface FlagReason {
  kind: FlagReasonKind;
  indicators: string[];
  adminReason: string | null;
  flaggedByAdminId: string | null;
  flaggedAt: string | null;
}

export interface FlaggedFeedbackItem {
  feedbackId: string;
  projectId: string;
  projectName: string | null;
  rating: number;
  comment: string;
  submittedAt: string;
  location?: string;
  riskScore: number;
  isFlagged: boolean;
  source: 'batch' | 'public';
  flagReason: FlagReason;
  deletedAt?: string;
  deletedByAdminId?: string;
  deleteReason?: string;
  purgeAfter?: string;
  daysUntilPurge?: number;
  isRestorable?: boolean;
}

export interface FlaggedFeedbackListResponse {
  items: FlaggedFeedbackItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
