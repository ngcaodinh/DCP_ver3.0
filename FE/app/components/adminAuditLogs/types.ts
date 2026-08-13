/** Contract DTO dùng chung cho màn hình và bảng admin audit logs. */
export const AUDIT_LOG_ACTIONS = [
  'MANUAL_APPROVE',
  'MANUAL_REJECT',
  'MANUAL_BANK_ACCOUNT_VIEW',
  'OVERRIDE_VOTE_APPROVE',
  'OVERRIDE_VOTE_REJECT',
  'OVERRIDE_EXPIRED',
  'FEEDBACK_FLAG',
  'FEEDBACK_UNFLAG',
  'SBT_MINT_RERUN_REQUESTED',
  'SBT_MINT_RERUN_ENQUEUED',
  'SBT_MINT_RERUN_DISPATCH_FAILED'
] as const;

export type AuditLogAction = typeof AUDIT_LOG_ACTIONS[number];

export interface AuditLogItem {
  actionId: string;
  actionType: AuditLogAction;
  adminId: string | null;
  adminRole: string | null;
  targetId: string;
  targetType: string;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requiresEscalation: boolean;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogListResponse {
  items: AuditLogItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
