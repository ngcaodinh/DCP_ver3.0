const SYNTHETIC_DONATION_ACK = 'I_UNDERSTAND_SYNTHETIC_DONATIONS';
const PERFORMANCE_ENVIRONMENTS = new Set(['test', 'performance']);

/**
 * Đọc cấu hình synthetic donation cho perf-stage.
 * Mục đích: chặn tuyệt đối việc giả lập giao dịch ở staging/production thông thường.
 */
export function isSyntheticDonationExecutionEnabled(): boolean {
  const requested = process.env.SYNTHETIC_DONATION_EXECUTION?.trim().toLowerCase() === 'true';
  const environment = process.env.NODE_ENV?.trim().toLowerCase() || 'development';
  const acknowledged = process.env.SYNTHETIC_DONATION_ACK?.trim() === SYNTHETIC_DONATION_ACK;

  return requested && PERFORMANCE_ENVIRONMENTS.has(environment) && acknowledged;
}

/** Trả về true khi có cấu hình synthetic nhưng bị khóa vì môi trường/mã xác nhận sai. */
export function isSyntheticDonationExecutionMisconfigured(): boolean {
  return process.env.SYNTHETIC_DONATION_EXECUTION?.trim().toLowerCase() === 'true'
    && !isSyntheticDonationExecutionEnabled();
}

/** Rate limit riêng cho perf-stage; các môi trường còn lại dùng giới hạn nghiệp vụ mặc định. */
export function getDonationRequestRateLimit(): number {
  return isSyntheticDonationExecutionEnabled() ? 25_000 : 100;
}

export { SYNTHETIC_DONATION_ACK };
