/** Đọc số nguyên môi trường trong khoảng cho phép để mọi worker dùng cùng cấu hình an toàn. */
function readBoundedInteger(variableName: string, defaultValue: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const configuredValue = Number.parseInt(process.env[variableName] ?? String(defaultValue), 10);
  if (!Number.isInteger(configuredValue) || configuredValue < minimum || configuredValue > maximum) {
    throw new Error(`${variableName} phải là số nguyên trong khoảng ${minimum}-${maximum}.`);
  }
  return configuredValue;
}

/** Đọc số thực môi trường trong khoảng cho phép cho chính sách kinh tế. */
function readBoundedNumber(variableName: string, defaultValue: number, minimum: number, maximum: number): number {
  const configuredValue = Number(process.env[variableName] ?? String(defaultValue));
  if (!Number.isFinite(configuredValue) || configuredValue < minimum || configuredValue > maximum) {
    throw new Error(`${variableName} phải nằm trong khoảng ${minimum}-${maximum}.`);
  }
  return configuredValue;
}

export const AUDITOR_STAKE_CONFIRMATION_BLOCKS = readBoundedInteger('AUDITOR_STAKE_CONFIRMATION_BLOCKS', 12, 1);
export const AUDITOR_STAKE_POLL_INTERVAL_MS = 15_000;
export const AUDITOR_STAKE_TIMEOUT_SWEEP_INTERVAL_MS = 15 * 60_000;
export const AUDITOR_STAKE_INTENT_TIMEOUT_MS = 24 * 60 * 60_000;
export const AUDITOR_STAKE_FAST_PATH_TIMEOUT_MS = 10 * 60_000;
export const AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST = readBoundedInteger(
  'AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST',
  250,
  1,
  2_000
);
export const AUDITOR_STAKE_GUARD_STALE_LOCK_MS = 15 * 60_000;
export const AUDITOR_SLASH_PERCENTAGE = readBoundedInteger('AUDITOR_SLASH_PERCENTAGE', 30, 1, 100);
export const AUDITOR_FIELD_AUDIT_BOUNTY_PERCENT = readBoundedNumber('AUDITOR_FIELD_AUDIT_BOUNTY_PERCENT', 0.5, Number.EPSILON, 0.5);
export const AUDITOR_MAX_FIELD_AUDITORS_PER_MILESTONE = readBoundedInteger('AUDITOR_MAX_FIELD_AUDITORS_PER_MILESTONE', 5, 1, 5);
export const AUDITOR_PENALTY_BAN_THRESHOLD = readBoundedInteger('AUDITOR_PENALTY_BAN_THRESHOLD', 3, 1);

/** Đọc phí PayOS do Kiểm toán viên chịu ngay lúc tạo payout để không làm nặng bootstrap ứng dụng. */
export function getAuditorPayoutFeeVnd(): number {
  const configuredValue = process.env.AUDITOR_PAYOUT_FEE_VND?.trim();
  if (!configuredValue) {
    throw new Error('AUDITOR_PAYOUT_FEE_VND phải được cấu hình trước khi tạo payout Auditor.');
  }
  const feeVnd = Number(configuredValue);
  if (!Number.isSafeInteger(feeVnd) || feeVnd < 1) {
    throw new Error('AUDITOR_PAYOUT_FEE_VND phải là số nguyên dương an toàn.');
  }
  return feeVnd;
}
