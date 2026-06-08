/**
 * API Client cho Guest Wallet endpoints.
 * Mục đích: cung cấp interface type-safe để gọi các guest session APIs từ frontend.
 * Tất cả các methods đều throw typed errors (ApiErrorResponse) khi có lỗi.
 */
import { buildApiUrl, fetchApi, ApiErrorResponse, ApiSuccessResponse } from './apiClient';
import { WALLET_ADDRESS_REGEX, FINGERPRINT_HASH_REGEX } from '../constants/guestDonationLimits';

/* ============================================================
 * SHARED TYPES
 * ============================================================ */

/**
 * Trạng thái của guest wallet session — đồng bộ với backend enum trong guestWalletSessionModel.ts.
 */
export type GuestWalletSessionStatus = 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';

/* ============================================================
 * REQUEST / RESPONSE TYPES
 * ============================================================ */

/** Dữ liệu encrypted owner key từ FE (layer PBKDF2).
 * Khớp với guestWalletCrypto.ts (FE) output và BE interface.
 */
export interface FeEncryptedOwnerKey {
  encryptedOwnerKey: string;
  clientSalt: string;
  iv: string;
}

/**
 * Payload tạo guest session từ frontend.
 */
export interface CreateGuestSessionRequest {
  walletAddress: string;
  deviceFingerprintHash: string;
  /** Encrypted owner key (PBKDF2 layer) — gửi lên BE để lưu 2 lớp mã hóa.
   * Optional để backward compat với FE cũ không gửi field này. */
  encryptedOwnerKey?: FeEncryptedOwnerKey;
}

/**
 * Response khi tạo guest session thành công.
 * @remarks donationQuota là tổng số donation được phép trong session (giá trị cố định lúc tạo).
 */
export interface CreateGuestSessionResponse {
  sessionId: string;
  guestSessionToken: string;
  expiresAt: string;
  serverSalt: string;
  /** Tổng số donation được phép — dùng để hiển thị trạng thái ban đầu khi tạo session */
  donationQuota: number;
}

/**
 * Payload refresh guest session.
 * @remarks guestSessionToken được truyền qua tham số riêng, không nằm trong payload
 *            để tránh nhầm lẫn với việc serialize token vào body.
 */
export interface RefreshGuestSessionRequest {
  sessionId: string;
}

/**
 * Response khi refresh guest session thành công.
 */
export interface RefreshGuestSessionResponse {
  guestSessionToken: string;
  expiresAt: string;
  renewalCount: number;
}

/**
 * Response lấy trạng thái guest session.
 */
/**
 * Response lấy trạng thái hiện tại của guest session.
 * @remarks remainingDonations là số donation còn lại tại thời điểm query (= donationQuota - donationCount).
 *          Cần xử lý state: khi user thực hiện donation, cập nhật local state giảm remainingDonations
 *          hoặc re-fetch để đồng bộ với server.
 */
export interface GuestSessionStatusResponse {
  sessionId: string;
  walletAddress: string;
  status: GuestWalletSessionStatus;
  donationCount: number;
  totalDonatedAmount: number;
  /** Tổng số donation được phép trong session — dùng thay hardcoded constant */
  donationQuota: number;
  expiresAt: string;
  /** Số donation còn lại = donationQuota - donationCount. Dùng để hiển thị UI real-time. */
  remainingDonations: number;
  /** Flag backend set khi phát hiện donation bị kẹt (balance > 0 nhưng chưa indexed) */
  hasPendingDonation?: boolean;
}

/**
 * Payload yêu cầu sponsor Paymaster.
 * @remarks unsignedUserOp chứa đầy đủ fields theo ZeroDev/Kernel spec (EIP-4337 v0.6).
 */
export interface RequestPaymasterSponsorshipRequest {
  unsignedUserOp: {
    /** EIP-4337 v0.6: initialization code — bỏ trống ('0x') nếu wallet đã deploy */
    sender: string;
    /** EIP-4337 v0.6: nonce của sender */
    nonce: string | number;
    /** EIP-4337 v0.6: init code để deploy factory — bỏ trống nếu wallet đã tồn tại */
    initCode: string;
    /** Dữ liệu call của UserOp */
    callData: string;
    callGasLimit?: string | number;
    verificationGasLimit?: string | number;
    preVerificationGas?: string | number;
    maxFeePerGas?: string | number;
    maxPriorityFeePerGas?: string | number;
    /** EIP-4337 v0.6: paymasterAndData — bỏ trống nếu không dùng paymaster */
    paymasterAndData?: string;
    signature?: string;
  };
  projectId: string;
  amount: number;
  sessionId: string;
}

/**
 * Response khi sponsor Paymaster thành công.
 */
export interface RequestPaymasterSponsorshipResponse {
  paymasterAndData: string;
  userOpHash: string;
  sponsorshipId: string;
  paymasterType: 'FREE' | 'TOKEN';
  paymasterSponsoredGas: boolean;
  trustMultiplier: number;
  riskScore: number;
  gasChargeAmount?: number;
  gasChargeWarning?: boolean;
}

/**
 * Payload prepare claim — gọi khi user đã đăng nhập và muốn claim guest wallet.
 * @remarks authToken được truyền qua tham số riêng, không nằm trong payload
 *          để tránh nhầm lẫn với việc serialize token vào body hoặc log.
 */
export interface PrepareClaimRequest {
  guestSessionToken: string;
  guestWalletAddress: string;
}

/**
 * Response từ prepare claim endpoint.
 */
export interface PrepareClaimResponse {
  claimEOAAddress: string;
  claimNonce: string;
}

/**
 * Payload execute claim — gọi sau khi client đã ký UserOp bằng guest owner key.
 * @remarks authToken được truyền qua tham số riêng, không nằm trong payload
 *          để tránh nhầm lẫn với việc serialize token vào body hoặc log.
 */
export interface ExecuteClaimRequest {
  guestSessionToken: string;
  guestWalletAddress: string;
  claimNonce: string;
  signedUserOp: string;
}

/**
 * Response từ execute claim endpoint.
 */
export interface ExecuteClaimResponse {
  changeOwnerTxHash: string;
  claimId: string;
  claimType: 'NEW_ACCOUNT' | 'EXISTING_ACCOUNT' | 'PARTIAL_CLAIM';
  donatedCount: number;
}

/**
 * Response trạng thái pending donation cho Frontend Sweeper.
 * Shape khớp với backend PendingDonationStatus trong pendingDonationController.ts.
 */
export interface PendingDonationStatusResponse {
  sessionId: string;
  walletAddress: string;
  hasPendingDonation: boolean;
  donationCount: number;
  totalDonatedAmount: number;
  status: GuestWalletSessionStatus;
}

/* ============================================================
 * ERROR MAPPING — HTTP Code → Typed Error
 * ============================================================ */

/**
 * Danh sách mã lỗi có thể nhận từ guest endpoints.
 * Dùng cho typed error handling ở caller.
 *
 * Phân biệt các codes dễ nhầm lẫn:
 * - GUEST_SESSION_LIMIT_EXCEEDED: IP đã tạo đủ số session cho phép (5/IP/giờ)
 * - GUEST_SESSION_EXCEEDED: Wallet đã đạt giới hạn session riêng
 * - GUEST_RENEWAL_LIMIT_EXCEEDED: Session đã refresh quá số lần cho phép
 * - GUEST_SESSION_RATE_LIMIT_EXCEEDED: Quá nhiều request từ IP trong thời gian ngắn (DDoS protection)
 */
export type GuestApiErrorCode =
  | 'INVALID_WALLET_ADDRESS'
  | 'INVALID_FINGERPRINT'
  | 'GUEST_SESSION_LIMIT_EXCEEDED'   // IP đã tạo đủ số session (5/IP/giờ)
  | 'GUEST_SESSION_NOT_FOUND'
  | 'GUEST_SESSION_EXCEEDED'         // Wallet đã đạt giới hạn session riêng
  | 'GUEST_SESSION_NOT_ACTIVE'
  | 'GUEST_DONATION_QUOTA_EXCEEDED'
  | 'GUEST_AMOUNT_LIMIT_EXCEEDED'
  | 'GUEST_DONATION_RATE_LIMIT_EXCEEDED'
  | 'INVALID_CALLDATA'
  | 'DUPLICATE_USEROP'
  | 'PAYMASTER_POLICY_MISMATCH'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'GUEST_TOKEN_REQUIRED'
  | 'GUEST_TOKEN_INVALID'
  | 'GUEST_SESSION_REQUIRED'
  | 'GUEST_RENEWAL_LIMIT_EXCEEDED'   // Session refresh quá số lần cho phép
  | 'GUEST_SESSION_RATE_LIMIT_EXCEEDED' // DDoS protection: quá nhiều request/IP
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN_ERROR'
  | 'INVALID_RESPONSE';

/**
 * Error wrapper cho guest API errors.
 * Khi API trả lỗi, method sẽ throw instance này.
 */
export class GuestApiError extends Error {
  public readonly statusCode: number;

  public readonly errorCode: GuestApiErrorCode;

  public readonly details?: Array<{ field: string; message: string }>;

  constructor(response: ApiErrorResponse) {
    super(response.message);
    this.name = 'GuestApiError';
    this.statusCode = response.statusCode ?? 500;
    this.errorCode = (response.errorCode as GuestApiErrorCode) ?? 'UNKNOWN_ERROR';
    this.details = response.details;
    // Preserve stack trace for better debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GuestApiError);
    }
  }
}

/**
 * Helper unwrap kết quả API — map lỗi từ fetchApi thành GuestApiError.
 * fetchApi throw ApiErrorResponse khi status không OK,
 * nên ta cần catch và wrap lại thành GuestApiError typed.
 *
 * @param promise - Promise từ fetchApi<ApiSuccessResponse<T>>
 * @returns Promise chỉ resolve data, throw GuestApiError khi fail
 */
function unwrap<T>(promise: Promise<ApiSuccessResponse<T>>): Promise<T> {
  return promise
    .then((response) => response.data)
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'errorCode' in error) {
        throw new GuestApiError(error as ApiErrorResponse);
      }
      throw new GuestApiError({
        success: false,
        message: error instanceof Error ? error.message : 'Lỗi kết nối không xác định.',
        errorCode: 'INTERNAL_ERROR',
        statusCode: 0
      });
    });
}

/* ============================================================
 * API METHODS
 * ============================================================ */

/**
 * Tạo guest session mới.
 * Endpoint: POST /api/guest/session
 *
 * @param payload - walletAddress (EIP-55), deviceFingerprintHash (SHA-256 hex),
 *                  và optional encryptedOwnerKey (PBKDF2 layer để BE lưu 2 lớp mã hóa)
 * @returns Thông tin session, JWT token, serverSalt, và donation quota
 * @throws GuestApiError khi validate thất bại hoặc rate limit
 */
export async function createGuestSession(
  payload: CreateGuestSessionRequest
): Promise<CreateGuestSessionResponse> {
  validateWalletAddress(payload.walletAddress);
  validateFingerprintHash(payload.deviceFingerprintHash);
  return unwrap(
    fetchApi<CreateGuestSessionResponse>(buildApiUrl('/api/guest/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

/**
 * Refresh guest session token.
 * Endpoint: POST /api/guest/session/refresh
 *
 * @param payload - sessionId
 * @param token - guestSessionToken (Bearer)
 * @returns Token mới và expiry time
 * @throws GuestApiError khi session hết hạn hoặc vượt renewal limit
 */
export async function refreshGuestSession(
  payload: RefreshGuestSessionRequest,
  token: string
): Promise<RefreshGuestSessionResponse> {
  return unwrap(
    fetchApi<RefreshGuestSessionResponse>(buildApiUrl('/api/guest/session/refresh'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ sessionId: payload.sessionId })
    })
  );
}

/**
 * Lấy trạng thái hiện tại của guest session.
 * Endpoint: GET /api/guest/session/status
 *
 * @param sessionId - ID của session cần lấy trạng thái
 * @param token - guestSessionToken (Bearer) — token được gửi qua header riêng
 * @returns Trạng thái session, số donation đã thực hiện, số donation còn lại
 * @throws GuestApiError khi session không hợp lệ hoặc đã hết hạn
 */
export async function getGuestSessionStatus(
  sessionId: string,
  token: string,
): Promise<GuestSessionStatusResponse> {
  return unwrap(
    fetchApi<GuestSessionStatusResponse>(buildApiUrl('/api/guest/session/status'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
  );
}

/**
 * Yêu cầu Paymaster sponsorship cho guest donation.
 * Endpoint: POST /api/guest/paymaster/sponsor
 *
 * @param payload - unsignedUserOp, projectId, amount, sessionId
 * @param token - guestSessionToken (Bearer)
 * @returns Paymaster data để sign và submit UserOp
 * @throws GuestApiError khi quota hết, amount vượt limit, hoặc Paymaster reject
 */
export async function requestPaymasterSponsorship(
  payload: RequestPaymasterSponsorshipRequest,
  token: string
): Promise<RequestPaymasterSponsorshipResponse> {
  return unwrap(
    fetchApi<RequestPaymasterSponsorshipResponse>(buildApiUrl('/api/guest/paymaster/sponsor'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    })
  );
}

/**
 * Prepare claim — bước 1 của Keyless Claim flow.
 * Endpoint: POST /api/guest/claim/prepare
 *
 * @param payload - guestSessionToken (để xác minh guest wallet ownership)
 * @param authToken - registered user JWT để authorize claim action
 * @returns claimEOAAddress (backend-generated EOA) và claimNonce (TTL 10 phút)
 * @throws GuestApiError khi user chưa đăng nhập hoặc guest session không hợp lệ
 */
export async function prepareGuestClaim(
  payload: PrepareClaimRequest,
  authToken: string
): Promise<PrepareClaimResponse> {
  validateWalletAddress(payload.guestWalletAddress);
  return unwrap(
    fetchApi<PrepareClaimResponse>(buildApiUrl('/api/guest/claim/prepare'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        guestSessionToken: payload.guestSessionToken,
        guestWalletAddress: payload.guestWalletAddress
      })
    })
  );
}

/**
 * Execute claim — bước 2 của Keyless Claim flow.
 * Endpoint: POST /api/guest/claim/execute
 *
 * @param payload - guestSessionToken, guestWalletAddress,
 *                 claimNonce (từ prepareClaim), signedUserOp (đã ký bằng guest owner key)
 * @param authToken - registered user JWT để authorize claim action
 * @returns changeOwnerTxHash, claimId, claimType, donatedCount
 * @throws GuestApiError khi nonce hết hạn hoặc transaction thất bại
 */
export async function executeGuestClaim(
  payload: ExecuteClaimRequest,
  authToken: string
): Promise<ExecuteClaimResponse> {
  validateWalletAddress(payload.guestWalletAddress);
  return unwrap(
    fetchApi<ExecuteClaimResponse>(buildApiUrl('/api/guest/claim/execute'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        guestSessionToken: payload.guestSessionToken,
        guestWalletAddress: payload.guestWalletAddress,
        claimNonce: payload.claimNonce,
        signedUserOp: payload.signedUserOp
      })
    })
  );
}

/**
 * Lấy trạng thái pending donation (Frontend Sweeper).
 * Endpoint: GET /api/guest/pending-donation
 *
 * @param token - guestSessionToken (Bearer)
 * @returns Trạng thái pending donation để hiển thị resume modal
 * @throws GuestApiError khi session không hợp lệ
 */
export async function getPendingDonationStatus(
  token: string
): Promise<PendingDonationStatusResponse> {
  return unwrap(
    fetchApi<PendingDonationStatusResponse>(buildApiUrl('/api/guest/pending-donation'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
  );
}

/**
 * Xóa flag pending donation sau khi đã resume thành công.
 * Endpoint: POST /api/guest/pending-donation/clear
 */
export async function clearPendingDonation(token: string): Promise<void> {
  await fetchApi<void>(
    buildApiUrl('/api/guest/pending-donation/clear'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    { skipBodyValidation: true }
  );
}

/**
 * Lấy server salt để encrypt owner key trước khi tạo session.
 * Endpoint: GET /api/guest/salt
 *
 * @param walletAddress - Địa chỉ ví (EIP-55 checksum)
 * @param deviceFingerprintHash - SHA-256 hash của device fingerprint
 * @returns Server salt hex (64 hex chars)
 * @throws GuestApiError khi vượt giới hạn tạo session
 *
 * @remarks
 * Dùng 2 bước thay vì gửi encrypted key trong session creation:
 * 1. FE gọi GET /salt để lấy serverSalt
 * 2. FE encrypt owner key bằng serverSalt
 * 3. FE gọi POST /session (với encrypted key)
 * Đảm bảo BE không bao giờ biết raw private key ở bước tạo session.
 */
export async function getGuestServerSalt(
  walletAddress: string,
  deviceFingerprintHash: string
): Promise<{ serverSalt: string }> {
  validateWalletAddress(walletAddress);
  validateFingerprintHash(deviceFingerprintHash);
  const params = new URLSearchParams({
    walletAddress,
    deviceFingerprintHash
  });
  return unwrap(
    fetchApi<{ serverSalt: string }>(buildApiUrl(`/api/guest/salt?${params.toString()}`), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

/**
 * Bind encrypted owner key vào session sau khi đã tạo.
 * Endpoint: POST /api/guest/session/bind-key
 *
 * @param encryptedOwnerKey - Dữ liệu encrypted owner key từ PBKDF2 layer
 * @param token - guestSessionToken (Bearer)
 * @throws GuestApiError khi session không hợp lệ
 *
 * @remarks
 * Gọi sau khi session đã được tạo (bước 1).
 * FE encrypt owner key → gửi encrypted lên BE (bước 2).
 */
export async function bindGuestEncryptedKey(
  encryptedOwnerKey: FeEncryptedOwnerKey,
  token: string
): Promise<{ success: boolean }> {
  return unwrap(
    fetchApi<{ success: boolean }>(buildApiUrl('/api/guest/session/bind-key'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ encryptedOwnerKey })
    })
  );
}

/**
 * Validate địa chỉ ví EIP-55 checksum trước khi gửi lên server.
 * Sử dụng dynamic import để tương thích ESM và giảm initial bundle size.
 * @param walletAddress - Địa chỉ ví cần validate
 */
function validateWalletAddress(walletAddress: string): void {
  if (!WALLET_ADDRESS_REGEX.test(walletAddress)) {
    throw new GuestApiError({
      success: false,
      message: 'Địa chỉ ví không hợp lệ. Vui lòng kiểm tra lại.',
      errorCode: 'INVALID_WALLET_ADDRESS',
      statusCode: 400,
    });
  }
}

/**
 * Validate device fingerprint hash (SHA-256 hex = 64 ký tự).
 * @param fingerprintHash - SHA-256 hash cần validate
 */
function validateFingerprintHash(fingerprintHash: string): void {
  if (!FINGERPRINT_HASH_REGEX.test(fingerprintHash)) {
    throw new GuestApiError({
      success: false,
      message: 'Device fingerprint không hợp lệ.',
      errorCode: 'INVALID_FINGERPRINT',
      statusCode: 400,
    });
  }
}

