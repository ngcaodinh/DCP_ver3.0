/**
 * Các hằng số giới hạn cho Guest Donation flow.
 * Tách riêng để dùng chung giữa GuestWalletProvider và guestApiClient,
 * đảm bảo consistency với backend (guestDonation.ts).
 */

/** Số donation tối đa cho guest mỗi session — đồng bộ với backend BE.G1 */
export const MAX_DONATIONS_PER_SESSION = 3;

/** Số tiền donation tối thiểu mỗi lần cho guest. */
export const MIN_AMOUNT_PER_DONATION = 10000;

/** Số tiền donation tối đa mỗi lần cho guest/anonymous. */
export const MAX_AMOUNT_PER_DONATION = 200000;

/** Regex kiểm tra địa chỉ ví EIP-55 — dùng chung cho cả validation ở Provider và API client */
export const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/** Regex kiểm tra device fingerprint hash (SHA-256 hex = 64 ký tự) */
export const FINGERPRINT_HASH_REGEX = /^[a-fA-F0-9]{64}$/;

/**
 * Địa chỉ EntryPoint contract ERC-4337 v0.6 (mainnet).
 * Fallback hardcode chỉ dùng khi NEXT_PUBLIC_ENTRYPOINT_ADDRESS chưa set.
 * Dùng cho estimateUserOpGas và các EIP-4337 operations.
 */
export const ENTRYPOINT_ADDRESS_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

/** Thời gian poll trạng thái session (ms) — dùng để sync donationCount real-time */
export const SESSION_POLL_INTERVAL_MS = 10 * 1000;

/** Thời gian auto-clear owner key cache (ms) — tránh key tồn tại lâu trong memory */
export const OWNER_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
