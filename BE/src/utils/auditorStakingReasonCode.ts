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

/** Dựng mã thưởng duy nhất theo vụ việc và Auditor để không dùng lại mã slash đã bất biến trên chain. */
export function buildAuditorRewardReasonCode(fieldCaseId: string, auditorUserId: string): string {
  return `REWARD:${normalizeReasonCodePart(fieldCaseId, 'Mã vụ việc')}:${normalizeReasonCodePart(auditorUserId, 'Mã Kiểm toán viên')}`;
}
