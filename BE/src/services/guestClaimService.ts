/**
 * Service chứa business logic cho Keyless Claim flow — tách biệt khỏi HTTP layer.
 *
 * Luồng Keyless Claim:
 * 1. prepareClaimEOA: Sinh ephemeral EOA (claimEOA), mã hóa private key bằng AES-256-GCM,
 *    lưu encrypted key vào MongoDB với TTL 10 phút.
 * 2. executeKeylessClaim: Nhận signed UserOp từ client (client đã ký Kernel.changeOwner),
 *    submit lên Bundler → EntryPoint → on-chain. Sau đó mã hóa claimEOA private key
 *    bằng AES-256-GCM với master key và lưu vào AuthUser.smartAccountOwnerEncryptedPrivateKey.
 * 3. handlePartialClaim: Fallback khi owner key đã mất — chỉ link donation history,
 *    không migrate wallet ownership.
 *
 * Security guarantees:
 * - Guest owner key KHÔNG BAO GIỜ rời client
 * - claimEOA private key chỉ tồn tại dạng encrypted trên server
 * - TTL 10 phút tự động xóa record nếu claim không hoàn tất
 * - Migration step re-encrypts với master key trước khi lưu permanent storage
 * - Tất cả write operations trong claim flow được bọc trong MongoDB transaction
 *   để đảm bảo atomicity — không có partial failure state.
 */
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import {
  GuestClaimEoaModel,
  GuestClaimEoa
} from '../models/guestClaimEoaModel';
import {
  WalletClaimHistoryModel
} from '../models/walletClaimHistoryModel';
import {
  findGuestWalletSessionById,
  markGuestSessionAsClaimed
} from '../repositories/guestWalletSessionRepository';
import {
  linkAuditsToClaimedUser
} from '../repositories/anonymousDonationAuditRepository';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';

const logger = getLogger();

/** Độ dài IV cho AES-256-GCM (12 bytes). */
const AES_IV_LENGTH = 12;

/** Thời gian sống của claim EOA record (10 phút). */
const CLAIM_EOA_TTL_MS = 10 * 60 * 1000;

/** Số iterations cho PBKDF2 key derivation. */
const PBKDF2_ITERATIONS = 100_000;

/**
 * Các hằng số gas mặc định cho UserOp — tránh magic numbers.
 * Giá trị phản ánh EIP-1559 gas structure và gas requirements
 * của EntryPoint/Account Abstraction trên các chain tương thích.
 */
const DEFAULT_CALL_GAS_LIMIT = '21000';
const DEFAULT_VERIFICATION_GAS_LIMIT = '100000';
const DEFAULT_PRE_VERIFICATION_GAS = '21000';
const DEFAULT_MAX_FEE_PER_GAS = '150000000';
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = '150000000';

/**
 * Retry config cho bundler submission.
 * Exponential backoff: base 1s, max 10s, tối đa 3 lần thử.
 */
const BUNDLER_RETRY_BASE_DELAY_MS = 1_000;
const BUNDLER_RETRY_MAX_DELAY_MS = 10_000;
const BUNDLER_RETRY_MAX_ATTEMPTS = 3;

/** Response type cho prepareClaimEOA. */
export type PrepareClaimResult = {
  claimEOAAddress: string;
  claimNonce: string;
  expiresAt: string;
};

/** Response type cho executeKeylessClaim. */
export type ExecuteKeylessClaimResult = {
  claimId: string;
  claimType: 'NEW_ACCOUNT' | 'EXISTING_ACCOUNT' | 'PARTIAL_CLAIM';
  changeOwnerTxHash: string;
  donationsMerged: number;
  /**
   * Layer-2 encrypted claim EOA private key.
   * Caller (Auth service) phải lưu vào AuthUser.smartAccountOwnerEncryptedPrivateKey
   * sau khi user đã đăng nhập thành công.
   * Optional: không có trong PARTIAL_CLAIM (không migrate ownership).
   */
  encryptedPrivateKey?: string;
  encryptionIv?: string;
  encryptionAuthTag?: string;
};

/** Request type cho executeKeylessClaim. */
export type ExecuteKeylessClaimRequest = {
  /** Session ID (UUID) — định danh phiên guest trong DB, KHÔNG phải JWT token. */
  sessionId: string;
  guestWalletAddress: string;
  claimNonce: string;
  /** User ID từ JWT — dùng để verify requester là đúng user đã khởi tạo claim (ngăn IDOR). */
  claimedByUserId: string;
  signedUserOp: {
    sender: string;
    nonce: bigint | string | number;
    initCode: `0x${string}` | string;
    callData: `0x${string}` | string;
    callGasLimit?: bigint | string | number;
    verificationGasLimit?: bigint | string | number;
    preVerificationGas?: bigint | string | number;
    maxFeePerGas?: bigint | string | number;
    maxPriorityFeePerGas?: bigint | string | number;
    paymasterAndData?: `0x${string}` | string;
    signature?: `0x${string}` | string;
  };
  /** Flag: user có smart account chưa link (tạo additionalWallet) hay chưa có (tạo walletAddress mới). */
  isNewAccount: boolean;
};

/**
 * Hàm lấy server secret cho encryption.
 * Fail-fast nếu secret chưa configured — ngăn hardcoded fallback để tránh
 * security incident khi deployment quên set env var.
 */
function getServerEncryptionSecret(): string {
  const secret = process.env.CLAIM_EOA_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      'CLAIM_EOA_ENCRYPTION_SECRET is not configured. ' +
      'This environment variable is required for claim EOA encryption.'
    );
  }
  if (secret.length < 32) {
    throw new Error(
      'CLAIM_EOA_ENCRYPTION_SECRET must be at least 32 characters. ' +
      'Current length: ' + secret.length
    );
  }
  return secret;
}

/**
 * Hàm lấy master key cho re-encryption trước khi lưu permanent storage.
 */
function getMasterEncryptionKey(): string {
  const key = process.env.CLAIM_EOA_MASTER_KEY;
  if (!key) {
    throw new Error(
      'CLAIM_EOA_MASTER_KEY is not configured. ' +
      'This environment variable is required for claim EOA master encryption.'
    );
  }
  if (key.length < 32) {
    throw new Error(
      'CLAIM_EOA_MASTER_KEY must be at least 32 characters. ' +
      'Current length: ' + key.length
    );
  }
  return key;
}

/**
 * Hàm derive AES-256 key từ secret và salt dùng PBKDF2.
 */
function deriveEncryptionKey(serverSecret: string, salt: string): Buffer {
  return crypto.pbkdf2Sync(
    serverSecret,
    salt,
    PBKDF2_ITERATIONS,
    32,
    'sha256'
  );
}

/**
 * Hàm mã hóa claim EOA private key bằng AES-256-GCM.
 *
 * Format output (lưu vào MongoDB):
 * - encryptedPrivateKey: salt(32) + ciphertext(hex)
 * - iv: IV(hex)
 * - authTag: GCM auth tag(hex)
 *
 * Salt được prepended vào encryptedPrivateKey để ciphertext tự-chứa.
 * Mỗi lần gọi tạo salt mới → ciphertext khác nhau (semantic security).
 */
export function encryptClaimEoaPrivateKey(
  privateKey: string,
  serverSecret: string
): { encryptedPrivateKey: string; iv: string; authTag: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = deriveEncryptionKey(serverSecret, salt);
  const iv = crypto.randomBytes(AES_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedPrivateKey: salt + encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Hàm mã hóa claim EOA private key (đã được encrypt 1 lần) bằng master key.
 * Dùng trong executeKeylessClaim trước khi lưu vào AuthUser.
 *
 * Khác với encryptClaimEoaPrivateKey: input là ciphertext đã được encrypt,
 * không phải plaintext private key. Dùng salt khác để tạo layer 2 encryption.
 *
 * Format output:
 * - encryptedPrivateKey: salt(32) + ciphertext(hex)
 * - iv: IV(hex)
 * - authTag: GCM auth tag(hex)
 */
export function reEncryptClaimEoaPrivateKey(
  alreadyEncryptedPrivateKey: string,
  masterKey: string
): { encryptedPrivateKey: string; iv: string; authTag: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = deriveEncryptionKey(masterKey, salt);
  const iv = crypto.randomBytes(AES_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(alreadyEncryptedPrivateKey, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedPrivateKey: salt + encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Hàm decode Kernel.changeOwner calldata để verify claim target address.
 * Kernel contract interface: changeOwner(address newOwner)
 *
 * Security: Ngăn attacker gửi calldata gọi function khác (VD: transfer token).
 * Chỉ chấp nhận calldata thực hiện Kernel.changeOwner đến đúng claimEOAAddress.
 */
function decodeAndVerifyKernelChangeOwnerCalldata(
  callData: string,
  expectedClaimEOAAddress: string
): { valid: true; targetAddress: string } | { valid: false; reason: string } {
  try {
    // Kernel ABI: function changeOwner(address newOwner)
    const kernelIface = new ethers.Interface([
      'function changeOwner(address newOwner)'
    ]);

    const cleanCallData = callData.startsWith('0x') ? callData : `0x${callData}`;
    const parsed = kernelIface.parseTransaction({ data: cleanCallData });

    if (!parsed) {
      return { valid: false, reason: 'Calldata không decode được.' };
    }

    if (parsed.name !== 'changeOwner') {
      return { valid: false, reason: `Calldata gọi function "${parsed.name}", không phải changeOwner.` };
    }

    const [newOwnerAddress] = parsed.args;
    const targetAddress = newOwnerAddress.toString().toLowerCase();

    if (targetAddress !== expectedClaimEOAAddress.toLowerCase()) {
      return {
        valid: false,
        reason: `Calldata changeOwner đến sai địa chỉ. Expected: ${expectedClaimEOAAddress}, got: ${targetAddress}`
      };
    }

    return { valid: true, targetAddress };
  } catch (error) {
    if (error instanceof Error && error.message.includes('invalid hex')) {
      return { valid: false, reason: 'Calldata không đúng định dạng hex.' };
    }
    return { valid: false, reason: 'Không thể decode calldata.' };
  }
}

/**
 * Hàm chuẩn bị claim EOA cho user.
 *
 * Quy trình:
 * 1. Validate guest session: status ACTIVE, wallet khớp
 * 2. Check session chưa được claim
 * 3. Generate claimEOA (ephemeral EOA) — private key tồn tại trong memory
 * 4. Encrypt private key bằng AES-256-GCM với server secret
 * 5. Lưu encrypted key vào MongoDB với TTL 10 phút
 * 6. Return claimEOA address + claimNonce (dùng cho execute step)
 *
 * @param sessionId - UUID định danh phiên guest trong DB (từ JWT payload, KHÔNG phải JWT token)
 * @throws ApplicationError nếu session không hợp lệ
 */
export async function prepareClaimEOA(
  sessionId: string,
  guestWalletAddress: string,
  claimedByUserId: string,
  ipAddress: string,
  userAgent: string
): Promise<PrepareClaimResult> {
  // Giữ input tương thích với caller/audit flow; E6 không ghi userAgent vào application log.
  void userAgent;
  const session = await findGuestWalletSessionById(sessionId);
  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 404, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== guestWalletAddress.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'GUEST_WALLET_MISMATCH');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError(
      `Session đang ở trạng thái "${session.status}", không thể bắt đầu claim.`,
      403,
      'GUEST_SESSION_NOT_ACTIVE'
    );
  }

  if (session.expiresAt < new Date()) {
    throw new ApplicationError('Guest session đã hết hạn.', 401, 'GUEST_SESSION_EXPIRED');
  }

  // Kiểm tra session đã được claim chưa bằng lookup theo sessionId.
  // Nếu đã có record → idempotent return (trả về claim cũ).
  // claimNonce (UUID độc lập) được sinh sau bước này — không dùng sessionId làm nonce
  // để tránh rò rỉ thông tin session qua API response.
  const existingClaim = await GuestClaimEoaModel.findOne({ sessionId })
    .lean<GuestClaimEoa>()
    .exec();

  if (existingClaim) {
    if (!existingClaim.usedAt) {
      // Idempotent: trả về record cũ nếu chưa used
      return {
        claimEOAAddress: existingClaim.claimEoaAddress,
        claimNonce: existingClaim.claimNonce,
        expiresAt: existingClaim.expiresAt.toISOString()
      };
    }
    throw new ApplicationError('Guest session đã được claim trước đó.', 409, 'GUEST_CLAIM_ALREADY_USED');
  }

  // Generate claimNonce độc lập (UUID) — không dùng JWT/sessionId làm nonce
  // để tránh rò rỉ thông tin session và tuân thủ principle of least privilege.
  const claimNonce = uuidv4();

  // Generate ephemeral EOA (claimEOA)
  const claimWallet = ethers.Wallet.createRandom();
  const claimEOAPrivateKey = claimWallet.privateKey;
  const claimEOAAddress = claimWallet.address.toLowerCase();

  // Encrypt private key với server secret — KHÔNG BAO GIỜ lưu plaintext
  const serverSecret = getServerEncryptionSecret();
  const encrypted = encryptClaimEoaPrivateKey(claimEOAPrivateKey, serverSecret);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_EOA_TTL_MS);

  // Lưu: sessionId = định danh phiên guest, claimNonce = UUID độc lập (idempotency key)
  // claimEoaAddress = claimEOAAddress (ephemeral EOA address — dùng trong execute để verify calldata)
  await GuestClaimEoaModel.create({
    sessionId,
    claimNonce,
    claimEoaAddress: claimEOAAddress,
    claimedByUserId,
    encryptedPrivateKey: encrypted.encryptedPrivateKey,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    expiresAt,
    usedAt: null
  });

  logger.info('Claim EOA prepared.', {
    claimNonce: '[CLAIM_NONCE_REDACTED]',
    sessionId,
    claimEOAAddress,
    ipAddress
  });

  return {
    claimEOAAddress,
    claimNonce,
    expiresAt: expiresAt.toISOString()
  };
}

/**
 * Hàm thực thi Keyless Claim.
 *
 * Quy trình:
 * 1. Validate guest session + claim record
 * 2. Verify claim nonce còn hợp lệ và chưa hết TTL
 * 3. Verify signedUserOp.callData là Kernel.changeOwner(claimEOAAddress)
 * 4. Submit signed UserOp lên Bundler/EntryPoint
 * 5. Re-encrypt claimEOA private key với master key → lưu vào AuthUser
 * 6. Update GuestWalletSession status = CLAIMED
 * 7. Link AnonymousDonationAudit records → claimedByUserId
 * 8. Tạo WalletClaimHistory record
 *
 * @throws ApplicationError nếu validation thất bại hoặc on-chain transaction thất bại
 */
export async function executeKeylessClaim(
  request: ExecuteKeylessClaimRequest,
  ipAddress: string,
  userAgent: string
): Promise<ExecuteKeylessClaimResult> {
  const { sessionId, guestWalletAddress, claimNonce, signedUserOp, isNewAccount, claimedByUserId } = request;

  // Bước 1: Validate guest session
  const session = await findGuestWalletSessionById(sessionId);
  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 404, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== guestWalletAddress.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'GUEST_WALLET_MISMATCH');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError('Session đã được claim hoặc không còn ACTIVE.', 403, 'GUEST_SESSION_NOT_ACTIVE');
  }

  // Bước 2: Validate claim record — lookup bằng claimNonce (UUID độc lập)
  const claimRecord = await GuestClaimEoaModel.findOne({ claimNonce })
    .lean<GuestClaimEoa>()
    .exec();

  if (!claimRecord) {
    throw new ApplicationError('Claim nonce không hợp lệ.', 400, 'GUEST_CLAIM_NONCE_INVALID');
  }

  // Defense in depth: verify claim thuộc về đúng session
  if (claimRecord.sessionId !== sessionId) {
    throw new ApplicationError('Claim nonce không khớp với session.', 403, 'CLAIM_SESSION_MISMATCH');
  }

  if (claimRecord.usedAt) {
    throw new ApplicationError('Claim đã được sử dụng trước đó.', 409, 'GUEST_CLAIM_ALREADY_USED');
  }

  if (claimRecord.expiresAt < new Date()) {
    throw new ApplicationError('Claim nonce đã hết hạn. Vui lòng thực hiện lại từ bước prepare.', 400, 'GUEST_CLAIM_NONCE_EXPIRED');
  }

  // Bước 3: Validate requester là đúng user đã khởi tạo claim (ngăn IDOR)
  // claimedByUserId param từ controller = authenticated user từ JWT
  if (claimRecord.claimedByUserId !== claimedByUserId) {
    throw new ApplicationError('Claim không thuộc về user hiện tại.', 403, 'FORBIDDEN');
  }

  // Bước 4: Verify calldata là Kernel.changeOwner đến claimEOAAddress
  // claimRecord.claimEoaAddress = claimEOAAddress trong prepare step
  const calldataVerification = decodeAndVerifyKernelChangeOwnerCalldata(
    signedUserOp.callData,
    claimRecord.claimEoaAddress
  );
  if (!calldataVerification.valid) {
    throw new ApplicationError(calldataVerification.reason, 400, 'INVALID_CALLDATA');
  }

  // Bước 5: Submit signed UserOp lên Bundler
  // Client đã ký Kernel.changeOwner(claimEOAAddress) bằng guest owner key
  // Backend submit lên ZeroDev Bundler API
  let changeOwnerTxHash: string;
  try {
    changeOwnerTxHash = await submitUserOpToBundler(signedUserOp);
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }
    // Lỗi không xác định — log và throw generic message
    logger.error('Failed to submit UserOp to bundler.', {
      sessionId,
      claimNonce: '[CLAIM_NONCE_REDACTED]',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw new ApplicationError(
      'Không thể submit transaction lên blockchain. Vui lòng thử lại.',
      502,
      'BUNDLER_SUBMISSION_FAILED'
    );
  }

  // Bước 6: Re-encrypt claimEOA private key với master key trước khi lưu permanent
  // Layer 2 encryption: encryptedPrivateKey (từ prepare step) được re-encrypt
  // Kết quả sẽ được lưu vào AuthUser.smartAccountOwnerEncryptedPrivateKey
  // bởi caller (Auth service) sau khi nhận response này
  const masterKey = getMasterEncryptionKey();
  const layer2Encryption = reEncryptClaimEoaPrivateKey(
    claimRecord.encryptedPrivateKey,
    masterKey
  );

  // Bước 7: Atomic write — tất cả DB updates trong một MongoDB transaction
  // Đảm bảo không có partial failure state:
  // nếu server crash giữa chừng, toàn bộ transaction bị rollback.
  const claimType: 'NEW_ACCOUNT' | 'EXISTING_ACCOUNT' = isNewAccount ? 'NEW_ACCOUNT' : 'EXISTING_ACCOUNT';
  const claimId = uuidv4();
  let auditsLinked = 0;

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // 7a: Update GuestWalletSession status = CLAIMED
      await markGuestSessionAsClaimed(sessionId, claimRecord.claimedByUserId, mongoSession);

      // 7b: Link AnonymousDonationAudit records → claimedByUserId
      auditsLinked = await linkAuditsToClaimedUser(sessionId, claimRecord.claimedByUserId, mongoSession);

      // 7c: Mark claim record as used
      await GuestClaimEoaModel.findOneAndUpdate(
        { claimNonce },
        { $set: { usedAt: new Date() } },
        { session: mongoSession }
      );

      // 7d: Tạo WalletClaimHistory record (immutable audit log)
      await WalletClaimHistoryModel.create([{
        claimId,
        sessionId: sessionId,
        guestWalletAddress,
        claimedByUserId: claimRecord.claimedByUserId,
        claimType,
        keyMigrated: true,
        donationsMerged: auditsLinked > 0,
        changeOwnerTxHash,
        ipAddress,
        userAgent,
        claimedAt: new Date(),
        createdAt: new Date()
      }], { session: mongoSession });
    });
  } finally {
    mongoSession.endSession();
  }

  logger.info('Keyless claim executed successfully.', {
    claimId,
    sessionId,
    guestWalletAddress,
    claimType,
    changeOwnerTxHash: changeOwnerTxHash ? `${changeOwnerTxHash.substring(0, 10)}...[REDACTED]` : undefined,
    donationsMerged: auditsLinked
  });

  return {
    claimId,
    claimType,
    changeOwnerTxHash,
    donationsMerged: auditsLinked,
    encryptedPrivateKey: layer2Encryption.encryptedPrivateKey,
    encryptionIv: layer2Encryption.iv,
    encryptionAuthTag: layer2Encryption.authTag
  };
}

/**
 * Hàm submit UserOp lên ZeroDev Bundler API với retry logic.
 * UserOp đã được client ký bằng guest owner key.
 * Retry với exponential backoff cho các lỗi tạm thời (network, HTTP 5xx).
 * Validation: Kiểm tra kết quả trả về là transaction hash hợp lệ (0x + 64 hex chars).
 */
async function submitUserOpToBundler(
  signedUserOp: ExecuteKeylessClaimRequest['signedUserOp']
): Promise<string> {
  const bundlerUrl = process.env.ZERODEV_BUNDLER_URL;
  if (!bundlerUrl) {
    throw new Error('ZERODEV_BUNDLER_URL is not configured.');
  }

  const normalizedUserOp = {
    sender: String(signedUserOp.sender),
    nonce: String(signedUserOp.nonce),
    initCode: String(signedUserOp.initCode || '0x'),
    callData: String(signedUserOp.callData),
    callGasLimit: String(signedUserOp.callGasLimit || DEFAULT_CALL_GAS_LIMIT),
    verificationGasLimit: String(signedUserOp.verificationGasLimit || DEFAULT_VERIFICATION_GAS_LIMIT),
    preVerificationGas: String(signedUserOp.preVerificationGas || DEFAULT_PRE_VERIFICATION_GAS),
    maxFeePerGas: String(signedUserOp.maxFeePerGas || DEFAULT_MAX_FEE_PER_GAS),
    maxPriorityFeePerGas: String(signedUserOp.maxPriorityFeePerGas || DEFAULT_MAX_PRIORITY_FEE_PER_GAS),
    paymasterAndData: String(signedUserOp.paymasterAndData || '0x'),
    signature: String(signedUserOp.signature || '0x')
  };

  const entryPointAddress = process.env.ZERODEV_ENTRY_POINT_ADDRESS;
  if (!entryPointAddress) {
    throw new Error(
      'ZERODEV_ENTRY_POINT_ADDRESS is not configured. ' +
      'This is a critical chain parameter — must be set explicitly per deployment.'
    );
  }

  let lastError: ApplicationError | Error | null = null;

  // Retry loop với exponential backoff cho các lỗi tạm thời
  for (let attempt = 0; attempt < BUNDLER_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptSubmit(normalizedUserOp, bundlerUrl, entryPointAddress);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Chỉ retry cho network errors và HTTP 5xx — không retry validation errors (4xx)
      const isRetryable =
        lastError instanceof ApplicationError &&
        (lastError.errorCode === 'BUNDLER_NETWORK_ERROR' ||
          lastError.errorCode === 'BUNDLER_HTTP_ERROR' ||
          lastError.errorCode === 'BUNDLER_RPC_ERROR');

      if (!isRetryable || attempt === BUNDLER_RETRY_MAX_ATTEMPTS - 1) {
        throw lastError;
      }

      // Exponential backoff: 1s → 2s → 4s, cap tại max delay
      const delay = Math.min(
        BUNDLER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
        BUNDLER_RETRY_MAX_DELAY_MS
      );
      logger.warn('Bundler submission failed, retrying.', {
        attempt: attempt + 1,
        maxAttempts: BUNDLER_RETRY_MAX_ATTEMPTS,
        delayMs: delay,
        errorCode: lastError instanceof ApplicationError ? lastError.errorCode : 'UNKNOWN'
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Bundler submission failed after retries.');
}

/**
 * Thực hiện một lần submit UserOp lên bundler.
 * Tách riêng để retry logic có thể gọi lại.
 */
async function attemptSubmit(
  normalizedUserOp: Record<string, string>,
  bundlerUrl: string,
  entryPointAddress: string
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_sendUserOperation',
        params: [normalizedUserOp, entryPointAddress],
        id: 1
      })
    });
  } catch (networkError) {
    // Fetch throws TypeError on network failure (DNS, connection refused, etc.)
    const errorMessage = networkError instanceof Error ? networkError.message : String(networkError);
    logger.warn('Bundler network connection failed.', { errorMessage });
    throw new ApplicationError(
      `Không thể kết nối đến bundler. Vui lòng kiểm tra kết nối mạng và thử lại.`,
      502,
      'BUNDLER_NETWORK_ERROR'
    );
  }

  if (!response.ok) {
    let rawBody = '[unreadable]';
    try { rawBody = await response.text(); } catch { /* ignore */ }
    // HTTP 5xx → retry được (server error tạm thời)
    // HTTP 4xx → không retry (client error, lặp lại không giải quyết được)
    const errorCode = response.status >= 500 ? 'BUNDLER_HTTP_ERROR' : 'BUNDLER_HTTP_CLIENT_ERROR';
    throw new ApplicationError(
      `Bundler responded with HTTP ${response.status}: ${rawBody}`,
      502,
      errorCode
    );
  }

  let result: { result?: unknown; error?: { message?: string } };
  try {
    result = await response.json() as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new ApplicationError(
      'Không thể parse response từ bundler.',
      502,
      'BUNDLER_INVALID_RESPONSE'
    );
  }

  if (result.error) {
    // Retry cho RPC errors — có thể là lỗi tạm thời của bundler
    throw new ApplicationError(
      `Bundler RPC error: ${result.error.message || 'Unknown'}`,
      502,
      'BUNDLER_RPC_ERROR'
    );
  }

  // Validate result.result là transaction hash hợp lệ: 0x + 64 hex chars
  const txHash = result.result as string | undefined;
  if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ApplicationError(
      'Bundler trả về kết quả không hợp lệ. Không phải transaction hash.',
      502,
      'BUNDLER_SUBMISSION_FAILED'
    );
  }

  return txHash;
}

/**
 * Hàm xử lý Partial Claim — fallback khi owner key đã mất.
 * Chỉ link donation history, không migrate wallet ownership.
 *
 * Quy trình:
 * 1. Validate session + verify không có active EOA claim đã được prepare
 * 2. Atomic write — mark claimed, link audits, create history trong transaction
 */
export async function handlePartialClaim(
  sessionId: string,
  guestWalletAddress: string,
  claimedByUserId: string,
  ipAddress: string,
  userAgent: string
): Promise<ExecuteKeylessClaimResult> {
  const session = await findGuestWalletSessionById(sessionId);
  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 404, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== guestWalletAddress.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'GUEST_WALLET_MISMATCH');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError('Session đã được claim hoặc không còn ACTIVE.', 403, 'GUEST_SESSION_NOT_ACTIVE');
  }

  // Kiểm tra không có EOA claim đã được prepare (claimType cần full flow)
  const existingClaimEoa = await GuestClaimEoaModel.findOne({ sessionId })
    .lean<GuestClaimEoa>()
    .exec();
  if (existingClaimEoa && !existingClaimEoa.usedAt) {
    throw new ApplicationError(
      'Session đã có EOA claim đang chờ. Vui lòng hoàn tất full claim flow.',
      409,
      'GUEST_CLAIM_ALREADY_PREPARED'
    );
  }

  const claimId = uuidv4();
  let auditsLinked = 0;

  // Atomic write — tất cả DB updates trong một MongoDB transaction
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // Thứ tự nhất quán với executeKeylessClaim: mark claimed → link audits → create history
      await markGuestSessionAsClaimed(sessionId, claimedByUserId, mongoSession);
      auditsLinked = await linkAuditsToClaimedUser(sessionId, claimedByUserId, mongoSession);
      await WalletClaimHistoryModel.create([{
        claimId,
        sessionId: sessionId,
        guestWalletAddress,
        claimedByUserId,
        claimType: 'PARTIAL_CLAIM',
        keyMigrated: false,
        donationsMerged: auditsLinked > 0,
        changeOwnerTxHash: '',
        ipAddress,
        userAgent,
        claimedAt: new Date(),
        createdAt: new Date()
      }], { session: mongoSession });
    });
  } finally {
    mongoSession.endSession();
  }

  logger.info('Partial claim executed (donation history only).', {
    claimId,
    sessionId,
    guestWalletAddress,
    donationsMerged: auditsLinked
  });

  return {
    claimId,
    claimType: 'PARTIAL_CLAIM',
    changeOwnerTxHash: '',
    donationsMerged: auditsLinked
  };
}
