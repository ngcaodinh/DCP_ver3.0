/**
 * Các hằng số dùng chung cho donation flow.
 * Tách ra đây để đảm bảo consistency giữa các service.
 */

/** Giới hạn donation count mỗi session (FR5.G). */
export const MAX_DONATIONS_PER_SESSION = 3;

/** Tổng số tiền tối đa mỗi session (USD equivalent, ~600000 token). */
export const MAX_TOTAL_AMOUNT_PER_SESSION = 600000;

/** Số tiền donation tối thiểu mỗi lần cho guest. */
export const MIN_AMOUNT_PER_DONATION = 1;

/** Số tiền donation tối đa mỗi lần cho guest. */
export const MAX_AMOUNT_PER_DONATION = 200000;

/** Ngưỡng risk score: >= 70 → dùng Token Paymaster. */
export const RISK_THRESHOLD_FOR_TOKEN_PAYMASTER = 70;

/** Số CharityToken khấu trừ khi dùng Token Paymaster. */
export const TOKEN_PAYMASTER_GAS_FEE_TOKEN = 1;

/** Tolerance cho cross-check amount (token). Nhỏ hơn đơn vị tối thiểu để ngăn tampering. */
export const AMOUNT_TOLERANCE = 0.001;
