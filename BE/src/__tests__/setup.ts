/**
 * Vitest global setup — chạy TRƯỚC khi bất kỳ module nào được import.
 * Dùng cho các biến môi trường bắt buộc phải có giá trị khi module được load.
 */

/** Mock CHARITY_TOKEN_ADDRESS để service module không throw khi import. */
process.env.CHARITY_TOKEN_ADDRESS = '0x1234567890123456789012345678901234567890';

/** Mock GUEST_JWT_SECRET cho guestAuthMiddleware tests. */
process.env.GUEST_JWT_SECRET = 'test-guest-jwt-secret-for-unit-tests-only';

/** Ví giả lập cho test allowlist admin; production bắt buộc đọc giá trị thật từ môi trường deploy. */
process.env.ADMIN_LOGIN_WALLET_ADDRESSES = '0x2222222222222222222222222222222222222222';
