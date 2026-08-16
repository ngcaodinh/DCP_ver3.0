/** Danh sách event nghiệp vụ được ghi bởi event logger trong phiên bản v1. */
export const PROJECT_EVENT_TYPES = [
  'DONATION_CONFIRMED',
  'SBT_MINTED',
  'SBT_MINT_FAILED',
  'SBT_MINT_DLQ',
  'SYBIL_FLAGGED',
  'ORACLE_VERIFIED',
  'OVERRIDE_REQUESTED',
  'OVERRIDE_EXECUTED',
  'DISBURSEMENT_TRANSFERRED',
  'DISBURSEMENT_TRANSFER_FAILED',
  'FEEDBACK_FLAGGED'
] as const;

export type ProjectEventType = typeof PROJECT_EVENT_TYPES[number];

/** Hai loại event bất biến được archive sau một năm và không xoá khỏi MongoDB. */
export const IMMUTABLE_EVENT_TYPES = ['SBT_MINTED', 'SYBIL_FLAGGED'] as const;

/** Phân loại event bất biến để retention service không áp dụng nhầm chính sách regular. */
export function isImmutableProjectEventType(eventType: ProjectEventType): boolean {
  return (IMMUTABLE_EVENT_TYPES as readonly string[]).includes(eventType);
}
