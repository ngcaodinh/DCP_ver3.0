/**
 * Route definitions cho guest session endpoints.
 * Tất cả các tuyến đều mount dưới API_GUEST_PREFIX.
 *
 * Middleware chain:
 * - attachRequestMetadata: gắn IP + User-Agent vào headers
 * - createGuestLayer1RateLimitMiddleware: Lớp 1 anti-DDoS (in-memory)
 * - createGuestSessionRateLimitMiddleware: Lớp 2 business limit (Redis)
 * - createGuestAuthMiddleware: xác thực guest JWT
 * - createGuestDonationRateLimitMiddleware: Lớp 2 donation sponsor limit (Redis)
 * - createAuthenticationMiddleware: xác thực registered user JWT (cho claim endpoints)
 */
import { Router, urlencoded } from 'express';
import {
  handleCreateGuestSession,
  handleRefreshGuestSession,
  handleGetGuestSessionStatus,
  handleSponsorGuestPaymaster,
  handlePrepareGuestClaim,
  handleExecuteGuestClaim,
  handlePartialGuestClaim,
  handleGetGuestServerSalt,
  handleBindGuestEncryptedKey
} from '../controllers/guestSessionController';
import { handleGuestRelayedDonation } from '../controllers/guestRelayDonationController';
import {
  handleInitGuestPayosDonation,
  handleGetGuestPayosDonationStatus
} from '../controllers/guestPayosController';
import { handleGuestPayosWebhook } from '../controllers/guestPayosWebhookController';
import {
  handleCreateGuestDeposit,
  handleGuestDepositWebhook,
  handleGetGuestDepositStatus,
  handleSponsorGuestDeposit,
  handleSubmitGuestDonation
} from '../controllers/guestDepositController';
import { API_GUEST_PREFIX } from '../config/apiPrefixes';
import {
  handleGetPendingDonationStatus,
  handleClearPendingDonation
} from '../controllers/pendingDonationController';
import {
  createGuestLayer1RateLimitMiddleware,
  createGuestSessionRateLimitMiddleware,
  createGuestDonationRateLimitMiddleware
} from '../middleware/guestRateLimitMiddleware';
import { createGuestAuthMiddleware } from '../middleware/guestAuthMiddleware';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';

/**
 * Hàm khởi tạo router cho guest endpoints.
 * Mục đích: gom các tuyến guest wallet theo chuẩn MVC.
 */
export function createGuestRoutes(): Router {
  const router = Router();

  const layer1RateLimit = createGuestLayer1RateLimitMiddleware();
  const sessionRateLimit = createGuestSessionRateLimitMiddleware();
  const guestAuth = createGuestAuthMiddleware();
  const donationRateLimit = createGuestDonationRateLimitMiddleware();
  const metadata = attachRequestMetadata();
  const authMiddleware = createAuthenticationMiddleware();

  // POST /api/guest/session — tạo phiên guest wallet mới
  // Chain: metadata → layer1 → redis-session-limit → handler
  router.post(
    '/session',
    metadata,
    layer1RateLimit,
    sessionRateLimit,
    handleCreateGuestSession
  );

  // GET /api/guest/salt — lấy server salt để encrypt owner key (relay flow)
  // Query params: walletAddress, deviceFingerprintHash
  // Chain: metadata → layer1 → redis-session-limit → handler
  // Dùng 2 bước: FE gọi GET /salt → encrypt owner key → POST /session/bind-key
  router.get(
    '/salt',
    metadata,
    layer1RateLimit,
    sessionRateLimit,
    handleGetGuestServerSalt
  );

  // POST /api/guest/session/bind-key — bind encrypted owner key vào session
  // Chain: metadata → layer1 → auth → handler
  // Gọi sau khi FE đã encrypt owner key bằng serverSalt từ GET /salt
  router.post(
    '/session/bind-key',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleBindGuestEncryptedKey
  );

  // POST /api/guest/session/refresh — làm mới token
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/session/refresh',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleRefreshGuestSession
  );

  // GET /api/guest/session/status — lấy trạng thái phiên
  // Chain: metadata → layer1 → auth → handler
  router.get(
    '/session/status',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleGetGuestSessionStatus
  );

  // GET /api/guest/pending-donation — lấy trạng thái pending donation (Frontend Sweeper)
  // Chain: metadata → layer1 → auth → handler
  router.get(
    '/pending-donation',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleGetPendingDonationStatus
  );

  // POST /api/guest/pending-donation/clear — xóa flag pending donation
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/pending-donation/clear',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleClearPendingDonation
  );

  // POST /api/guest/paymaster/sponsor — sponsor Paymaster cho guest donation
  // Chain: metadata → layer1 → auth → donation-rate-limit → handler
  router.post(
    '/paymaster/sponsor',
    metadata,
    layer1RateLimit,
    guestAuth,
    donationRateLimit,
    handleSponsorGuestPaymaster
  );

  // POST /api/guest/relay/donate — relay donation qua BE (backend tự gửi transaction)
  // Chain: metadata → layer1 → auth → donation-rate-limit → handler
  // Dùng cho guest users thay thế luồng EIP-4337 (FE sign → ZeroDev Paymaster → Bundler)
  router.post(
    '/relay/donate',
    metadata,
    layer1RateLimit,
    guestAuth,
    donationRateLimit,
    handleGuestRelayedDonation
  );

  // POST /api/guest/claim/prepare — chuẩn bị claim EOA (Keyless Claim)
  // Chain: metadata → layer1 (anti-DDoS) → auth (registered user JWT) → handler
  router.post(
    '/claim/prepare',
    metadata,
    layer1RateLimit,
    authMiddleware,
    handlePrepareGuestClaim
  );

  // POST /api/guest/claim/execute — thực thi keyless claim
  // Chain: metadata → layer1 (anti-DDoS) → auth (registered user JWT) → handler
  router.post(
    '/claim/execute',
    metadata,
    layer1RateLimit,
    authMiddleware,
    handleExecuteGuestClaim
  );

  // POST /api/guest/claim/partial — partial claim (fallback khi owner key mất)
  // Chain: metadata → layer1 (anti-DDoS) → auth (registered user JWT) → handler
  router.post(
    '/claim/partial',
    metadata,
    layer1RateLimit,
    authMiddleware,
    handlePartialGuestClaim
  );

  // POST /api/guest/deposit/sponsor — sponsor UserOp và tạo payment link (ZeroDev flow)
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/deposit/sponsor',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleSponsorGuestDeposit
  );

  // POST /api/guest/deposit/submit — submit signed UserOp sau PayOS redirect
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/deposit/submit',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleSubmitGuestDonation
  );

  // POST /api/guest/deposit/create — tạo payment link PayOS cho guest deposit (legacy)
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/deposit/create',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleCreateGuestDeposit
  );

  // POST /api/guest/deposit/webhook — webhook PayOS cho guest deposit
  // Chain: metadata → layer1 → bodyParseMiddleware → handler (không auth — PayOS gọi)
  // PayOS gửi body dạng application/x-www-form-urlencoded, không phải JSON.
  router.post(
    '/deposit/webhook',
    metadata,
    layer1RateLimit,
    urlencoded({ extended: false }),
    handleGuestDepositWebhook
  );

  // GET /api/guest/deposit/status — lấy trạng thái guest deposit
  // Chain: metadata → layer1 → auth → handler
  router.get(
    '/deposit/status',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleGetGuestDepositStatus
  );

  // POST /api/guest/payos/init — khởi tạo thanh toán PayOS, trả về QR cho FE
  // Chain: metadata → layer1 → auth → handler
  router.post(
    '/payos/init',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleInitGuestPayosDonation
  );

  // GET /api/guest/payos/status/:orderCode — lấy trạng thái PayOS donation
  // Chain: metadata → layer1 → auth → handler
  router.get(
    '/payos/status/:orderCode',
    metadata,
    layer1RateLimit,
    guestAuth,
    handleGetGuestPayosDonationStatus
  );

  // POST /api/guest/payos/webhook — webhook PayOS gọi khi thanh toán thành công
  // Chain: metadata → layer1 → bodyParseMiddleware → handler (không auth — PayOS gọi)
  // PayOS gửi body dạng application/x-www-form-urlencoded, không phải JSON.
  router.post(
    '/payos/webhook',
    metadata,
    layer1RateLimit,
    urlencoded({ extended: false }),
    handleGuestPayosWebhook
  );

  return router;
}
