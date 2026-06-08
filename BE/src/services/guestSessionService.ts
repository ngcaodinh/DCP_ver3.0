/**
 * Service chứa business logic cho guest session — tách biệt khỏi HTTP layer.
 * Các hàm trong service không biết gì về Express request/response,
 * chỉ nhận plain data và trả về kết kết quả.
 */
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ethers } from 'ethers';
import {
  createGuestWalletSession,
  findGuestWalletSessionById,
  updateGuestWalletSession,
  countRecentSessionsByFingerprint,
  countRecentSessionsByIp
} from '../repositories/guestWalletSessionRepository';
import { signGuestSessionToken } from '../config/guestJsonWebToken';
import { evaluateAndSaveGuestRisk, computeRiskLevelAndMultiplier } from './guestRiskService';
import {
  upsertGuestDonationRisk
} from '../repositories/guestDonationRiskRepository';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { MAX_DONATIONS_PER_SESSION } from '../constants/guestDonation';
import { getRedisClientIfReady } from '../config/redis';
import { decryptPbkdf2Layer } from '../utils/guestCryptoUtils';
import { encryptOwnerPrivateKey } from './zeroDevService';

const logger = getLogger();

/** TTL mặc định của guest session: 72 giờ. */
const SESSION_TTL_MS = 72 * 60 * 60 * 1000;

/** Giới hạn tối đa session theo fingerprint (FR5.G). */
const MAX_SESSIONS_PER_FINGERPRINT = 3;

/** Giới hạn tối đa session theo IP trong 1 giờ (anti-burst). */
const MAX_SESSIONS_PER_IP_PER_HOUR = 3;

/** Giới hạn số lần refresh session. */
const MAX_RENEWAL_COUNT = 5;

/** Số bytes của server salt. */
const SERVER_SALT_BYTES = 32;

/** Response type cho tạo session thành công. */
export type CreateGuestSessionResult = {
  sessionId: string;
  guestSessionToken: string;
  expiresAt: string;
  serverSalt: string;
  donationQuota: number;
};

/** Response type cho refresh session thành công. */
export type RefreshGuestSessionResult = {
  guestSessionToken: string;
  expiresAt: string;
  renewalCount: number;
};

/** Response type cho session status. */
export type SessionStatusResult = {
  sessionId: string;
  walletAddress: string;
  status: string;
  donationCount: number;
  totalDonatedAmount: number;
  expiresAt: string;
  remainingDonations: number;
};

/**
 * Hàm sinh server salt ngẫu nhiên.
 * Server salt được trả về client để compute encryption key (PBKDF2).
 * Mục đích: mỗi session có salt riêng, tránh rainbow table attack.
 */
function generateServerSalt(): string {
  return crypto.randomBytes(SERVER_SALT_BYTES).toString('hex');
}

/**
 * Chuyển đổi và kiểm tra địa chỉ ví có đúng định dạng EIP-55 checksum không.
 * ethers v6: getAddress() throws nếu không phải valid hex hoặc checksum sai.
 * Sau khi validate, chuyển sang lowercase để lưu vào MongoDB (case-insensitive).
 */
function normalizeAndValidateWalletAddress(address: string): string {
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    throw new ApplicationError(
      'Địa chỉ ví không hợp lệ.',
      400,
      'INVALID_WALLET_ADDRESS'
    );
  }
}

/**
 * Kiểm tra fingerprint hash có đúng định dạng SHA-256 hex không.
 * @param hash - Fingerprint hash cần kiểm tra
 * @returns true nếu hợp lệ
 */
function isValidFingerprintHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

/**
 * Dữ liệu encrypted owner key từ FE (layer PBKDF2).
 * Khớp với output của encryptOwnerKey() trong guestWalletCrypto.ts (FE).
 */
export interface FeEncryptedOwnerKey {
  /** Chuỗi hex của ciphertext đã mã hóa AES-256-GCM */
  encryptedOwnerKey: string;
  /** Client salt dùng cho PBKDF2 (hex, 16 bytes) */
  clientSalt: string;
  /** Initialization vector dùng cho AES-GCM (hex, 12 bytes) */
  iv: string;
}

/**
 * Hàm tạo server salt cho guest session — dùng cho relay flow.
 * Tách riêng để FE có thể lấy salt trước khi encrypt owner key.
 *
 * @param walletAddress - Địa chỉ ví (EIP-55 checksum)
 * @param deviceFingerprintHash - SHA-256 hash của device fingerprint
 * @param ipAddress - IP của client
 * @param userAgent - User-Agent string
 * @returns Server salt hex (64 hex chars)
 * @throws ApplicationError nếu vượt giới hạn
 */
export async function generateServerSaltForGuest(
  walletAddress: string,
  deviceFingerprintHash: string,
  ipAddress: string,
  userAgent: string
): Promise<string> {
  const normalizedWallet = normalizeAndValidateWalletAddress(walletAddress);

  if (!isValidFingerprintHash(deviceFingerprintHash)) {
    throw new ApplicationError(
      'Device fingerprint không hợp lệ.',
      400,
      'INVALID_FINGERPRINT'
    );
  }

  const currentTimeMs = Date.now();
  const oneDayAgo = new Date(currentTimeMs - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(currentTimeMs - 60 * 60 * 1000);

  const [fingerprintCount, ipCount] = await Promise.all([
    countRecentSessionsByFingerprint(deviceFingerprintHash, oneDayAgo),
    countRecentSessionsByIp(ipAddress, oneHourAgo)
  ]);

  if (fingerprintCount >= MAX_SESSIONS_PER_FINGERPRINT) {
    throw new ApplicationError(
      'Đã đạt giới hạn tạo phiên. Vui lòng sử dụng trình duyệt khác hoặc đăng nhập để tiếp tục.',
      429,
      'GUEST_SESSION_LIMIT_EXCEEDED'
    );
  }

  if (ipCount >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    throw new ApplicationError(
      'Phát hiện nhiều phiên từ cùng địa chỉ IP. Vui lòng thử lại sau 1 giờ.',
      429,
      'GUEST_IP_BURST_DETECTED'
    );
  }

  // Sinh salt và lưu vào Redis với TTL 5 phút
  // FE sẽ dùng salt này để encrypt owner key, rồi gửi session creation
  // Redis key dùng walletAddress vì đó là giá trị duy nhất FE gửi kèm salt
  const serverSalt = generateServerSalt();
  const redisKey = `guest:salt:${normalizedWallet}`;

  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    await redisClient.setEx(redisKey, 300, serverSalt); // TTL 5 phút
  } else {
    // Redis không khả dụng → fallback: dùng salt trong memory (không recommended)
    // Session creation sẽ bị fail nếu salt không match
    logger.warn('Redis unavailable. Salt stored in memory (may cause relay failures).', { walletAddress: normalizedWallet });
  }

  return serverSalt;
}

/**
 * Hàm bind encrypted owner key vào session đã tạo.
 * Gọi sau khi FE đã encrypt owner key bằng serverSalt.
 *
 * @param sessionId - ID của session
 * @param encryptedOwnerKey - Dữ liệu encrypted từ FE
 * @param deviceFingerprintHash - Hash của fingerprint để giải mã
 * @throws ApplicationError nếu session không hợp lệ
 */
export async function bindGuestEncryptedOwnerKey(
  sessionId: string,
  encryptedOwnerKey: FeEncryptedOwnerKey,
  deviceFingerprintHash: string,
  walletAddress: string
): Promise<void> {
  const normalizedWallet = normalizeAndValidateWalletAddress(walletAddress);
  const session = await findGuestWalletSessionById(sessionId);

  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 404, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'GUEST_WALLET_MISMATCH');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError('Guest session không còn ACTIVE.', 403, 'GUEST_SESSION_NOT_ACTIVE');
  }

  // Giải mã FE-PBKDF2 layer → mã hóa BE layer → lưu DB
  let smartAccountOwnerEncryptedPrivateKey: string | null = null;

  try {
    const rawOwnerKey = decryptPbkdf2Layer(
      encryptedOwnerKey,
      deviceFingerprintHash,
      session.serverSalt
    );
    smartAccountOwnerEncryptedPrivateKey = encryptOwnerPrivateKey(`0x${rawOwnerKey}`);
  } catch (error) {
    logger.warn('Failed to encrypt owner key for relay during bind.', {
      sessionId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw new ApplicationError('Không thể mã hóa owner key. Vui lòng thử lại.', 400, 'ENCRYPTION_FAILED');
  }

  await updateGuestWalletSession(sessionId, {
    smartAccountOwnerEncryptedPrivateKey
  });

  logger.info('Guest encrypted owner key bound.', { sessionId });
}

export async function createNewGuestSession(
  walletAddress: string,
  deviceFingerprintHash: string,
  ipAddress: string,
  userAgent: string,
  encryptedOwnerKey?: FeEncryptedOwnerKey
): Promise<CreateGuestSessionResult> {
  const normalizedWallet = normalizeAndValidateWalletAddress(walletAddress);

  if (!isValidFingerprintHash(deviceFingerprintHash)) {
    throw new ApplicationError(
      'Device fingerprint không hợp lệ.',
      400,
      'INVALID_FINGERPRINT'
    );
  }

  // Kiểm tra giới hạn fingerprint (≤3/24h) và IP burst (≤3/1h) song song
  // để giảm độ trễ DB round-trip từ 2 lần thành 1 lần.
  const currentTimeMs = Date.now();
  const oneDayAgo = new Date(currentTimeMs - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(currentTimeMs - 60 * 60 * 1000);
  const [fingerprintCount, ipCount] = await Promise.all([
    countRecentSessionsByFingerprint(deviceFingerprintHash, oneDayAgo),
    countRecentSessionsByIp(ipAddress, oneHourAgo)
  ]);

  if (fingerprintCount >= MAX_SESSIONS_PER_FINGERPRINT) {
    throw new ApplicationError(
      'Đã đạt giới hạn tạo phiên. Vui lòng sử dụng trình duyệt khác hoặc đăng nhập để tiếp tục.',
      429,
      'GUEST_SESSION_LIMIT_EXCEEDED'
    );
  }

  if (ipCount >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    throw new ApplicationError(
      'Phát hiện nhiều phiên từ cùng địa chỉ IP. Vui lòng thử lại sau 1 giờ.',
      429,
      'GUEST_IP_BURST_DETECTED'
    );
  }

  const sessionId = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  // Relay flow: FE gọi GET /salt trước → salt được lưu trong Redis
  // Session creation đọc salt từ Redis và xóa key ngay
  let serverSalt: string;
  let smartAccountOwnerEncryptedPrivateKey: string | null = null;

  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    const redisKey = `guest:salt:${normalizedWallet}`;
    const storedSalt = await redisClient.get(redisKey);
    if (storedSalt) {
      serverSalt = storedSalt;
      await redisClient.del(redisKey); // Xóa key sau khi dùng — one-time use
    } else {
      // Không có salt trong Redis (FE gọi session creation trực tiếp, hoặc đã hết hạn)
      // Fallback: tạo salt mới (relay không hoạt động)
      serverSalt = generateServerSalt();
      logger.warn('No salt found in Redis for session creation. Relay may not work.', { walletAddress: normalizedWallet });
    }
  } else {
    // Redis không khả dụng → dùng salt mới (relay fail-safe)
    serverSalt = generateServerSalt();
    logger.warn('Redis unavailable during session creation. Relay may not work.', { walletAddress: normalizedWallet });
  }

  // Xử lý 2 lớp mã hóa owner key (backend relay flow)
  // Nếu FE gửi encryptedOwnerKey → giải mã PBKDF2 layer → mã hóa BE layer → lưu DB
  // Nếu không có (backward compat) → smartAccountOwnerEncryptedPrivateKey = null
  if (encryptedOwnerKey) {
    try {
      // Giải mã FE-PBKDF2 layer để lấy raw owner key
      // BE cần: encryptedOwnerKey, clientSalt, iv (từ FE) + fingerprintHash + serverSalt (từ Redis)
      const rawOwnerKey = decryptPbkdf2Layer(
        encryptedOwnerKey,
        deviceFingerprintHash,
        serverSalt
      );

      // Mã hóa lại bằng BE key (SMART_ACCOUNT_ENCRYPTION_KEY)
      // ethers Wallet.privateKey luôn có prefix 0x
      smartAccountOwnerEncryptedPrivateKey = encryptOwnerPrivateKey(`0x${rawOwnerKey}`);

      logger.info('Owner key encrypted for relay.', { sessionId });
    } catch (error) {
      // Không fail session creation vì relay là optional feature
      // Backward compat: guest session vẫn hoạt động, chỉ không dùng được relay
      logger.warn('Failed to encrypt owner key for relay. Session created without relay capability.', {
        sessionId,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await createGuestWalletSession({
    sessionId,
    walletAddress: normalizedWallet,
    deviceFingerprintHash,
    ipAddress,
    userAgent,
    status: 'ACTIVE',
    donationCount: 0,
    totalDonatedAmount: 0,
    totalSponsoredGas: 0,
    renewalCount: 0,
    claimedByUserId: null,
    serverSalt,
    smartAccountOwnerEncryptedPrivateKey,
    hasPendingDonation: false,
    pendingAlertSentAt: null,
    expiresAt,
    createdAt: now,
    updatedAt: now
  });

  // Initial risk assessment sau khi tạo session (Task 4.2)
  // Đánh giá risk ngay để có risk record sẵn sàng cho Paymaster sponsorship.
  // Truyền `now` để checkSessionVelocity exclude chính session này khỏi count.
  // Nếu risk evaluation thất bại (VD: RPC error, DB upsert failure), dùng fallback
  // risk an toàn (SAFE, score=0, multiplier=1.0) để tránh dangling record.
  try {
    await evaluateAndSaveGuestRisk(
      { sessionId, walletAddress: normalizedWallet, deviceFingerprintHash },
      ipAddress,
      now
    );
  } catch (error) {
    // Fallback risk an toàn khi evaluation thất bại — không fail toàn bộ session creation
    const { riskLevel, trustMultiplier } = computeRiskLevelAndMultiplier(0);
    try {
      await upsertGuestDonationRisk(sessionId, {
        sessionId,
        walletAddress: normalizedWallet,
        riskScore: 0,
        riskLevel,
        trustMultiplier,
        factors: {
          walletAgeScore: 0,
          ipBurstScore: 0,
          fingerprintReuseScore: 0,
          donationPatternScore: 0,
          sessionVelocityScore: 0
        },
        blocked: false,
        blockedAt: null,
        blockedReason: null
      });
    } catch (fallbackError) {
      // Session tồn tại nhưng không có risk record — Paymaster phải handle
      logger.error('Risk fallback upsert also failed. Session has no risk record.', {
        sessionId,
        errorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
    }
    logger.warn('Risk evaluation failed, using safe fallback.', {
      sessionId,
      walletAddress: normalizedWallet,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }

  const guestSessionToken = signGuestSessionToken({
    sessionId,
    walletAddress: normalizedWallet
  });

  logger.info('Guest session created.', { sessionId, walletAddress: normalizedWallet });

  return {
    sessionId,
    guestSessionToken,
    expiresAt: expiresAt.toISOString(),
    serverSalt,
    donationQuota: 3
  };
}

/**
 * Hàm refresh guest session token.
 *
 * Quy trình:
 * 1. Verify existing token
 * 2. Fetch session from DB
 * 3. Check renewal count < 5
 * 4. Increment renewal count
 * 5. Issue new token
 *
 * @throws Error nếu session không hợp lệ hoặc vượt giới hạn refresh
 */
export async function refreshExistingSession(
  sessionId: string,
  walletAddress: string
): Promise<RefreshGuestSessionResult> {
  const session = await findGuestWalletSessionById(sessionId);
  if (!session) {
    throw new ApplicationError(
      'Guest session không tồn tại.',
      404,
      'GUEST_SESSION_NOT_FOUND'
    );
  }

  if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new ApplicationError(
      'Wallet address không khớp với session.',
      403,
      'GUEST_WALLET_MISMATCH'
    );
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError(
      'Guest session đã hết hạn hoặc bị vô hiệu hóa.',
      401,
      'GUEST_SESSION_NOT_ACTIVE'
    );
  }

  if (session.expiresAt < new Date()) {
    throw new ApplicationError(
      'Guest session đã hết hạn. Vui lòng tạo phiên mới.',
      401,
      'GUEST_SESSION_EXPIRED'
    );
  }

  if (session.renewalCount >= MAX_RENEWAL_COUNT) {
    throw new ApplicationError(
      'Đã đạt giới hạn làm mới phiên. Vui lòng tạo phiên mới.',
      429,
      'GUEST_RENEWAL_LIMIT_EXCEEDED'
    );
  }

  const newExpiry = new Date(Date.now() + SESSION_TTL_MS);

  await updateGuestWalletSession(sessionId, {
    renewalCount: session.renewalCount + 1,
    expiresAt: newExpiry
  });

  const newToken = signGuestSessionToken({
    sessionId,
    walletAddress: session.walletAddress
  });

  logger.info('Guest session refreshed.', { sessionId, newRenewalCount: session.renewalCount + 1 });

  return {
    guestSessionToken: newToken,
    expiresAt: newExpiry.toISOString(),
    renewalCount: session.renewalCount + 1
  };
}

/**
 * Hàm lấy trạng thái hiện tại của guest session.
 * Dùng cho frontend polling để kiểm tra session còn hợp lệ không.
 */
export async function getSessionStatus(sessionId: string): Promise<SessionStatusResult> {
  const session = await findGuestWalletSessionById(sessionId);
  if (!session) {
    throw new ApplicationError(
      'Guest session không tồn tại.',
      404,
      'GUEST_SESSION_NOT_FOUND'
    );
  }

  const remainingDonations = Math.max(0, MAX_DONATIONS_PER_SESSION - session.donationCount);

  return {
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    status: session.status,
    donationCount: session.donationCount,
    totalDonatedAmount: session.totalDonatedAmount,
    expiresAt: session.expiresAt.toISOString(),
    remainingDonations
  };
}
