import { ApplicationError } from './applicationError';

/** Chuẩn hóa thành phần reason code để contract đóng băng không bị va chạm namespace giữa thưởng và phạt. */
function normalizeReasonCodePart(value: string, label: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new ApplicationError(`${label} không được để trống.`, 400, 'VALIDATION_ERROR');
  return normalizedValue;
}

/** Dựng mã slash duy nhất theo vụ việc và Auditor, tách hẳn với namespace REWARD của contract. */
export function buildAuditorPenaltyReasonCode(fieldCaseId: string, auditorUserId: string): string {
  return `PENALTY:${normalizeReasonCodePart(fieldCaseId, 'Mã vụ việc')}:${normalizeReasonCodePart(auditorUserId, 'Mã Kiểm toán viên')}`;
}

/** Dựng mã thưởng duy nhất theo biên bản và Auditor để khóa idempotency on-chain trùng với ledger. */
export function buildAuditorRewardReasonCode(fieldReportId: string, auditorUserId: string): string {
  return `REWARD:${normalizeReasonCodePart(fieldReportId, 'Mã biên bản')}:${normalizeReasonCodePart(auditorUserId, 'Mã Kiểm toán viên')}`;
}
