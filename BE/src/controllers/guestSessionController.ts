/**
 * Controller xử lý HTTP requests cho guest session endpoints.
 * Nhiệm vụ: parse input → gọi service → trả response.
 * Không chứa business logic.
 */
import { Request, Response } from 'express';
import { ethers } from 'ethers';
import {
  createNewGuestSession,
  refreshExistingSession,
  getSessionStatus,
  bindGuestEncryptedOwnerKey
} from '../services/guestSessionService';
import { sponsorGuestDonation } from '../services/guestPaymasterService';
import {
  prepareClaimEOA,
  executeKeylessClaim,
  handlePartialClaim
} from '../services/guestClaimService';
import { sendErrorResponse, sendSuccessResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import { GuestSessionRequest } from '../middleware/guestAuthMiddleware';
import { createAuthenticationMiddleware, AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { getLogger } from '../config/logger';
import { verifyGuestSessionToken } from '../config/guestJsonWebToken';
import { findGuestWalletSessionById } from '../repositories/guestWalletSessionRepository';
import { ApplicationError } from '../utils/applicationError';
import { generateServerSaltForGuest } from '../services/guestSessionService';
import crypto from 'crypto';

const logger = getLogger();

/**
 * Hàm extract IP address từ request.
 * Ưu tiên: request.ip đã được Express xử lý an toàn qua trust proxy setting.
 * Việc tự parse header x-forwarded-for sẽ tạo lỗ hổng IP spoofing
 * (kẻ tấn công cố tình gửi X-Forwarded-For để giả mạo IP).
 * app.ts đã set 'trust proxy', Express sẽ tự động populate request.ip
 * từ right-most non-trusted hop một cách an toàn.
 */
function extractClientIp(request: Request): string {
  return request.ip || 'unknown';
}

/**
 * Hàm extract metadata từ request headers.
 * Mục đích: lấy IP và User-Agent chuẩn hóa.
 */
function extractRequestMetadata(request: Request): { ipAddress: string; userAgent: string } {
  const ipAddress = extractClientIp(request);
  const userAgent =
    typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent']
      : 'unknown';
  return { ipAddress, userAgent };
}

/**
 * Hàm handle ApplicationError bằng instanceof thay vì duck-typing.
 * Tách riêng thành helper để tránh duplicate code across handlers.
 * Tương thích với cả ApplicationError thật và mock trong test.
 */
function handleApplicationError(
  response: Response,
  error: unknown,
  fallbackMessage: string
): void {
  if (error instanceof ApplicationError) {
    sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
    return;
  }
  sendErrorFromUnknown(response, error, fallbackMessage);
}

/**
 * Hàm validate EVM wallet address.
 * Dùng ethers.getAddress() để verify địa chỉ EVM hợp lệ (checksum).
 * Không so sánh strict với input vì ZeroDev luôn trả checksummed address
 * nhưng client/UI có thể gửi lowercase — ethers vẫn accept.
 * Nếu ethers.getAddress() không throw → địa chỉ hợp lệ.
 */
function isValidEthereumAddress(address: string): boolean {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hàm validate SHA-256 hash format.
 * Device fingerprint hash phải là hex string 64 ký tự.
 */
function isValidFingerprintHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Dữ liệu encrypted owner key từ FE (layer PBKDF2).
 * Khớp với output của encryptOwnerKey() trong guestWalletCrypto.ts (FE).
 */
interface FeEncryptedOwnerKey {
  encryptedOwnerKey: string;
  clientSalt: string;
  iv: string;
}

/**
 * Hàm xử lý tạo guest session mới.
 * Endpoint: POST /api/guest/session
 */
export async function handleCreateGuestSession(
  request: Request,
  response: Response
): Promise<void> {
  const body = request.body as {
    walletAddress?: string;
    deviceFingerprintHash?: string;
    encryptedOwnerKey?: FeEncryptedOwnerKey;
  };

  const { walletAddress, deviceFingerprintHash, encryptedOwnerKey } = body;

  if (!walletAddress || !isValidEthereumAddress(walletAddress)) {
    sendErrorResponse(
      response,
      400,
      'Địa chỉ ví không hợp lệ. Vui lòng cung cấp địa chỉ Ethereum hợp lệ.',
      'INVALID_WALLET_ADDRESS'
    );
    return;
  }

  if (!deviceFingerprintHash || !isValidFingerprintHash(deviceFingerprintHash)) {
    sendErrorResponse(
      response,
      400,
      'Device fingerprint không hợp lệ. Vui lòng kiểm tra trình duyệt của bạn.',
      'INVALID_FINGERPRINT'
    );
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  try {
    const result = await createNewGuestSession(
      walletAddress,
      deviceFingerprintHash,
      ipAddress,
      userAgent,
      encryptedOwnerKey
    );

    logger.info('Guest session created via API.', {
      sessionId: result.sessionId,
      walletAddress
    });

    sendSuccessResponse(response, 201, 'Tạo phiên guest thành công.', result);
  } catch (error: unknown) {
    logger.warn('Guest session creation failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      walletAddress
    });

    handleApplicationError(response, error, 'Không thể tạo phiên guest. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý refresh guest session.
 * Endpoint: POST /api/guest/session/refresh
 * Middleware: guestAuthMiddleware đã verify token và gắn guestSession vào request.
 */
export async function handleRefreshGuestSession(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  try {
    const result = await refreshExistingSession(
      guestSession.sessionId,
      guestSession.walletAddress
    );

    logger.info('Guest session refreshed via API.', {
      sessionId: guestSession.sessionId
    });

    sendSuccessResponse(response, 200, 'Làm mới phiên guest thành công.', result);
  } catch (error: unknown) {
    logger.warn('Guest session refresh failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });

    handleApplicationError(response, error, 'Không thể làm mới phiên guest. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý lấy trạng thái guest session.
 * Endpoint: GET /api/guest/session/status
 * Middleware: guestAuthMiddleware đã verify token và gắn guestSession vào request.
 */
export async function handleGetGuestSessionStatus(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  try {
    const result = await getSessionStatus(guestSession.sessionId);

    sendSuccessResponse(response, 200, 'Lấy trạng thái phiên guest thành công.', result);
  } catch (error: unknown) {
    logger.warn('Guest session status check failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });

    sendErrorFromUnknown(response, error, 'Không thể lấy trạng thái phiên guest.');
  }
}

/**
 * Hàm xử lý sponsor Paymaster cho guest donation.
 * Endpoint: POST /api/guest/paymaster/sponsor
 * Middleware: guestAuthMiddleware đã verify token và gắn guestSession vào request.
 *
 * Quy trình:
 * 1. Validate request body
 * 2. Check unsignedUserOp.sender khớp session.walletAddress
 * 3. Gọi sponsorGuestDonation() service
 * 4. Return paymaster sponsorship data
 */
export async function handleSponsorGuestPaymaster(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  const body = request.body as {
    unsignedUserOp?: unknown;
    projectId?: string;
    amount?: number;
    sessionId?: string;
  };

  if (!body.unsignedUserOp || typeof body.unsignedUserOp !== 'object') {
    sendErrorResponse(response, 400, 'unsignedUserOp là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  if (!body.projectId || typeof body.projectId !== 'string') {
    sendErrorResponse(response, 400, 'projectId là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  if (typeof body.amount !== 'number' || body.amount <= 0) {
    sendErrorResponse(response, 400, 'amount phải là số lớn hơn 0.', 'INVALID_REQUEST');
    return;
  }

  // Giới hạn amount tối đa được kiểm tra trong service layer
  // (validate calldata + cross-check với body.amount)

  if (!body.sessionId || typeof body.sessionId !== 'string') {
    sendErrorResponse(response, 400, 'sessionId là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  if (body.sessionId !== guestSession.sessionId) {
    sendErrorResponse(response, 403, 'sessionId không khớp với token.', 'FORBIDDEN');
    return;
  }

  const unsignedUserOp = body.unsignedUserOp as Record<string, unknown>;

  if (!unsignedUserOp.sender || typeof unsignedUserOp.sender !== 'string') {
    sendErrorResponse(response, 400, 'unsignedUserOp.sender là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  if (unsignedUserOp.sender.toLowerCase() !== guestSession.walletAddress.toLowerCase()) {
    sendErrorResponse(response, 403, 'Sender address không khớp với session wallet.', 'FORBIDDEN');
    return;
  }

  if (!unsignedUserOp.callData || typeof unsignedUserOp.callData !== 'string') {
    sendErrorResponse(response, 400, 'unsignedUserOp.callData là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  try {
    const result = await sponsorGuestDonation(
      {
        unsignedUserOp: unsignedUserOp as Parameters<typeof sponsorGuestDonation>[0]['unsignedUserOp'],
        projectId: body.projectId,
        amount: body.amount,
        sessionId: body.sessionId
      },
      ipAddress,
      userAgent
    );

    logger.info('Guest paymaster sponsored via API.', {
      sessionId: guestSession.sessionId,
      paymasterType: result.paymasterType,
      riskScore: result.riskScore
    });

    sendSuccessResponse(response, 200, 'Sponsor Paymaster thành công.', result);
  } catch (error: unknown) {
    logger.warn('Guest paymaster sponsorship failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });

    handleApplicationError(response, error, 'Không thể sponsor Paymaster. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý prepare claim EOA cho user.
 * Endpoint: POST /api/guest/claim/prepare
 * Auth: registered user JWT (authenticationMiddleware)
 *
 * Quy trình:
 * 1. Extract authenticated user từ request (đã được middleware verify)
 * 2. Validate guestSessionToken + guestWalletAddress
 * 3. Gọi prepareClaimEOA() service
 * 4. Return claimEOAAddress + claimNonce + expiresAt
 */
export async function handlePrepareGuestClaim(
  request: Request,
  response: Response
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;
  const authenticatedUser = authRequest.authenticatedUser;

  if (!authenticatedUser || !authenticatedUser.userId) {
    sendErrorResponse(response, 401, 'Vui lòng đăng nhập để tiếp tục.', 'UNAUTHENTICATED');
    return;
  }

  const body = request.body as {
    guestSessionToken?: string;
    guestWalletAddress?: string;
  };

  if (!body.guestSessionToken || typeof body.guestSessionToken !== 'string') {
    sendErrorResponse(response, 400, 'guestSessionToken là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  if (!body.guestWalletAddress || !isValidEthereumAddress(body.guestWalletAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_WALLET_ADDRESS');
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  // Bước bảo mật: Xác thực guestSessionToken thuộc về user đã đăng nhập
  // Ngăn chặn IDOR - attacker có JWT hợp lệ không thể claim ví guest của người khác
  let decodedToken: { sessionId: string; walletAddress: string };
  try {
    decodedToken = verifyGuestSessionToken(body.guestSessionToken);
  } catch {
    sendErrorResponse(response, 401, 'Guest session token không hợp lệ hoặc đã hết hạn.', 'INVALID_SESSION_TOKEN');
    return;
  }

  // Verify session tồn tại và các ràng buộc trước khi gọi service.
  // Controller pre-validation là fail-fast layer — không tạo claimEOA nếu session invalid.
  // Service cũng validate lại để defense-in-depth (chống trường hợp gọi thẳng service không qua controller).
  // Tradeoff: 2 DB queries thay vì 1 để đảm bảo early rejection không tốn resource tạo EOA.
  try {
    const sessionFromDb = await findGuestWalletSessionById(decodedToken.sessionId);

    if (!sessionFromDb) {
      sendErrorResponse(response, 404, 'Guest session không tồn tại.', 'GUEST_SESSION_NOT_FOUND');
      return;
    }

    if (sessionFromDb.walletAddress.toLowerCase() !== body.guestWalletAddress.toLowerCase()) {
      sendErrorResponse(response, 403, 'Wallet address không khớp với session.', 'GUEST_WALLET_MISMATCH');
      return;
    }

    if (sessionFromDb.status !== 'ACTIVE') {
      sendErrorResponse(
        response,
        403,
        `Session đang ở trạng thái "${sessionFromDb.status}", không thể bắt đầu claim.`,
        'GUEST_SESSION_NOT_ACTIVE'
      );
      return;
    }
  } catch (error: unknown) {
    logger.error('Unexpected error during session pre-validation.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: '[SESSION_REDACTED]'
    });
    sendErrorResponse(response, 500, 'Lỗi khi xác thực session. Vui lòng thử lại.', 'INTERNAL_ERROR');
    return;
  }

  try {
    const result = await prepareClaimEOA(
      decodedToken.sessionId,
      body.guestWalletAddress,
      authenticatedUser.userId,
      ipAddress,
      userAgent
    );

    logger.info('Guest claim prepared via API.', {
      claimNonce: result.claimNonce,
      userId: authenticatedUser.userId,
      guestWalletAddress: body.guestWalletAddress
    });

    sendSuccessResponse(response, 201, 'Chuẩn bị claim thành công. Vui lòng ký transaction trong 10 phút.', result);
  } catch (error: unknown) {
    logger.warn('Guest claim prepare failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      userId: authenticatedUser.userId
    });

    handleApplicationError(response, error, 'Không thể chuẩn bị claim. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý execute keyless claim.
 * Endpoint: POST /api/guest/claim/execute
 * Auth: registered user JWT (authenticationMiddleware)
 *
 * Quy trình:
 * 1. Validate authenticated user
 * 2. Validate request body (claimNonce, signedUserOp, isNewAccount)
 * 3. Gọi executeKeylessClaim() service
 * 4. Return claimId, claimType, changeOwnerTxHash, donationsMerged
 */
export async function handleExecuteGuestClaim(
  request: Request,
  response: Response
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;
  const authenticatedUser = authRequest.authenticatedUser;

  if (!authenticatedUser || !authenticatedUser.userId) {
    sendErrorResponse(response, 401, 'Vui lòng đăng nhập để tiếp tục.', 'UNAUTHENTICATED');
    return;
  }

  const body = request.body as {
    guestSessionToken?: string;
    guestWalletAddress?: string;
    claimNonce?: string;
    signedUserOp?: unknown;
    isNewAccount?: boolean;
  };

  if (!body.guestSessionToken || typeof body.guestSessionToken !== 'string') {
    sendErrorResponse(response, 400, 'guestSessionToken là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  if (!body.guestWalletAddress || !isValidEthereumAddress(body.guestWalletAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_WALLET_ADDRESS');
    return;
  }

  if (!body.claimNonce || typeof body.claimNonce !== 'string') {
    sendErrorResponse(response, 400, 'claimNonce là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  if (!body.signedUserOp || typeof body.signedUserOp !== 'object') {
    sendErrorResponse(response, 400, 'signedUserOp là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  const signedUserOp = body.signedUserOp as Record<string, unknown>;

  if (!signedUserOp.sender || typeof signedUserOp.sender !== 'string') {
    sendErrorResponse(response, 400, 'signedUserOp.sender là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  if (!signedUserOp.callData || typeof signedUserOp.callData !== 'string') {
    sendErrorResponse(response, 400, 'signedUserOp.callData là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  // Decode JWT để lấy sessionId (UUID) — tách biệt với claimNonce
  let decodedToken: { sessionId: string; walletAddress: string };
  try {
    decodedToken = verifyGuestSessionToken(body.guestSessionToken);
  } catch {
    sendErrorResponse(response, 401, 'Guest session token không hợp lệ hoặc đã hết hạn.', 'INVALID_SESSION_TOKEN');
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  try {
    const result = await executeKeylessClaim(
      {
        // sessionId: UUID từ JWT payload — định danh phiên guest trong DB
        // claimNonce: UUID độc lập từ prepare step — idempotency key
        sessionId: decodedToken.sessionId,
        guestWalletAddress: body.guestWalletAddress,
        claimNonce: body.claimNonce,
        claimedByUserId: authenticatedUser.userId,
        signedUserOp: signedUserOp as Parameters<typeof executeKeylessClaim>[0]['signedUserOp'],
        isNewAccount: Boolean(body.isNewAccount)
      },
      ipAddress,
      userAgent
    );

    logger.info('Guest claim executed via API.', {
      claimId: result.claimId,
      claimType: result.claimType,
      userId: authenticatedUser.userId
    });

    sendSuccessResponse(response, 200, 'Claim ví guest thành công! Donations đã được liên kết.', result);
  } catch (error: unknown) {
    logger.warn('Guest claim execute failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      userId: authenticatedUser.userId
    });

    handleApplicationError(response, error, 'Không thể thực hiện claim. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý partial claim (fallback khi owner key mất).
 * Endpoint: POST /api/guest/claim/partial
 * Auth: registered user JWT (authenticationMiddleware)
 *
 * Khi user không thể ký Kernel.changeOwner() (owner key đã mất),
 * chỉ link donation history mà không migrate wallet ownership.
 */
export async function handlePartialGuestClaim(
  request: Request,
  response: Response
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;
  const authenticatedUser = authRequest.authenticatedUser;

  if (!authenticatedUser || !authenticatedUser.userId) {
    sendErrorResponse(response, 401, 'Vui lòng đăng nhập để tiếp tục.', 'UNAUTHENTICATED');
    return;
  }

  const body = request.body as {
    guestSessionToken?: string;
    guestWalletAddress?: string;
  };

  if (!body.guestSessionToken || typeof body.guestSessionToken !== 'string') {
    sendErrorResponse(response, 400, 'guestSessionToken là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }

  if (!body.guestWalletAddress || !isValidEthereumAddress(body.guestWalletAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_WALLET_ADDRESS');
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  try {
    // Decode guestSessionToken (JWT) để lấy sessionId (UUID) cho service
    const decodedToken = verifyGuestSessionToken(body.guestSessionToken);
    const result = await handlePartialClaim(
      decodedToken.sessionId,
      body.guestWalletAddress,
      authenticatedUser.userId,
      ipAddress,
      userAgent
    );

    logger.info('Guest partial claim executed via API.', {
      claimId: result.claimId,
      userId: authenticatedUser.userId
    });

    sendSuccessResponse(
      response,
      200,
      'Donation history đã được liên kết. Wallet ownership không thể migrate do thiếu owner key.',
      result
    );
  } catch (error: unknown) {
    logger.warn('Guest partial claim failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      userId: authenticatedUser.userId
    });

    handleApplicationError(response, error, 'Không thể thực hiện partial claim. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý lấy server salt cho việc mã hóa owner key trước.
 * Endpoint: GET /api/guest/salt
 * Chain: metadata → layer1 → session-rate-limit → handler
 *
 * Quy trình:
 * 1. Validate walletAddress và fingerprint hash
 * 2. Check fingerprint limit và IP burst
 * 3. Generate server salt
 * 4. Return server salt để FE encrypt owner key
 *
 * Lưu ý: Không tạo session — FE gọi POST /session/bind-key sau khi encrypt.
 *         Chia 2 bước để BE không bao giờ biết raw private key.
 */
export async function handleGetGuestServerSalt(
  request: Request,
  response: Response
): Promise<void> {
  const query = request.query as {
    walletAddress?: string;
    deviceFingerprintHash?: string;
  };

  const { walletAddress, deviceFingerprintHash } = query;

  if (!walletAddress || !isValidEthereumAddress(walletAddress)) {
    sendErrorResponse(
      response,
      400,
      'Địa chỉ ví không hợp lệ. Vui lòng cung cấp địa chỉ Ethereum hợp lệ.',
      'INVALID_WALLET_ADDRESS'
    );
    return;
  }

  if (!deviceFingerprintHash || !isValidFingerprintHash(deviceFingerprintHash)) {
    sendErrorResponse(
      response,
      400,
      'Device fingerprint không hợp lệ. Vui lòng kiểm tra trình duyệt của bạn.',
      'INVALID_FINGERPRINT'
    );
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  try {
    const serverSalt = await generateServerSaltForGuest(
      walletAddress,
      deviceFingerprintHash,
      ipAddress,
      userAgent
    );

    sendSuccessResponse(response, 200, 'Lấy server salt thành công.', { serverSalt });
  } catch (error: unknown) {
    handleApplicationError(response, error, 'Không thể lấy server salt. Vui lòng thử lại.');
  }
}

/**
 * Hàm xử lý bind encrypted owner key vào session sau khi đã encrypt.
 * Endpoint: POST /api/guest/session/bind-key
 * Chain: metadata → layer1 → auth → handler
 *
 * Quy trình:
 * 1. Validate session (từ middleware)
 * 2. Nhận encryptedOwnerKey từ body
 * 3. Giải mã PBKDF2 layer → mã hóa BE layer → lưu DB
 */
export async function handleBindGuestEncryptedKey(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  const body = request.body as {
    encryptedOwnerKey?: FeEncryptedOwnerKey;
  };

  if (!body.encryptedOwnerKey) {
    sendErrorResponse(response, 400, 'encryptedOwnerKey là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  const { encryptedOwnerKey } = body;

  if (
    !encryptedOwnerKey.encryptedOwnerKey ||
    !encryptedOwnerKey.clientSalt ||
    !encryptedOwnerKey.iv
  ) {
    sendErrorResponse(response, 400, 'encryptedOwnerKey thiếu các trường bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  try {
    await bindGuestEncryptedOwnerKey(
      guestSession.sessionId,
      encryptedOwnerKey,
      guestSession.deviceFingerprintHash,
      guestSession.walletAddress
    );

    logger.info('Guest encrypted owner key bound to session.', {
      sessionId: guestSession.sessionId
    });

    sendSuccessResponse(response, 200, 'Bind encrypted key thành công.', { success: true });
  } catch (error: unknown) {
    logger.warn('Guest encrypted key bind failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });
    handleApplicationError(response, error, 'Không thể bind encrypted key. Vui lòng thử lại.');
  }
}
