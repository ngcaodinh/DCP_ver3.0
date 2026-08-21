/** Đọc số giờ cửa sổ khiếu nại với fallback an toàn theo quyết định quản trị. */
export function getChallengeWindowMs(): number {
  const configuredHours = Number(process.env.PROJECT_CHALLENGE_WINDOW_HOURS || 48);
  const normalizedHours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 48;
  return normalizedHours * 60 * 60 * 1000;
}

/** Đọc thời hạn xét xử với fallback an toàn theo quyết định quản trị. */
export function getArbitrationTimeoutMs(): number {
  const configuredDays = Number(process.env.ARBITRATION_TIMEOUT_DAYS || 7);
  const normalizedDays = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 7;
  return normalizedDays * 24 * 60 * 60 * 1000;
}

export const PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
export const PROJECT_ACTIVATION_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const PROJECT_ACTIVATION_LOCK_RETRY_MS = 60 * 1000;
export const PROJECT_ACTIVATION_BATCH_LIMIT = 50;
export const PROJECT_CHALLENGE_DAILY_LIMIT = 5;

/** Tính backoff cấp số nhân, giới hạn ở mức retry vận hành tối đa sáu giờ. */
export function getProjectActivationBackoffMs(attemptCount: number): number {
  return Math.min(PROJECT_ACTIVATION_BACKOFF_MS, 10 * 60 * 1000 * (4 ** Math.max(0, attemptCount - 1)));
}
