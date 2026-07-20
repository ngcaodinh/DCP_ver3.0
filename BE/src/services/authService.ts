import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import jsonWebToken, { Secret, SignOptions } from 'jsonwebtoken';
import { getGoogleAuthConfig } from '../config/googleAuth';
import { getJsonWebTokenConfig, getJsonWebTokenSecret } from '../config/jsonWebToken';
import { parseDurationToMilliseconds } from '../utils/timeUtils';

import { createZeroDevSmartAccount } from './zeroDevService';
import {
  AuthUser,
  AuditLogEntry,
  addAuditLog,
  createRefreshSession,
  findRefreshSessionById,
  findUserByEmail,
  findUserById,
  getActiveRefreshSessionsByUserId,
  revokeRefreshSession,
  revokeRefreshSessionsByUserId,
  updateRefreshSession,
  updateUser,
  createUser
} from '../models/authModel';
import { getLogger } from '../config/logger';

const googleAuthConfig = getGoogleAuthConfig();
const googleOAuthClient = new OAuth2Client(googleAuthConfig.clientId);
const logger = getLogger();

const jsonWebTokenConfig = getJsonWebTokenConfig();
const jsonWebTokenSecret: Secret = getJsonWebTokenSecret();
const refreshTokenExpirationMs = parseDurationToMilliseconds(
  jsonWebTokenConfig.refreshTokenExpiresIn,
  24 * 60 * 60 * 1000
);

type GoogleUserProfile = {
  email: string;
  fullName: string;
  socialAccountId: string;
  isEmailVerified: boolean;
};

/**
 * Hàm kiểm tra lỗi trùng dữ liệu MongoDB.
 * Mục đích: nhận diện lỗi race-condition khi tạo user đồng thời.
 */
function isDuplicateMongoError(errorObject: unknown): boolean {
  const mongoError = errorObject as { code?: number };
  return mongoError?.code === 11000;
}


/**
 * Hàm xác thực token Google.
 * Mục đích: đảm bảo token hợp lệ và có issuer đúng.
 */
async function verifyGoogleIdentityToken(identityToken: string): Promise<TokenPayload> {
  const ticket = await googleOAuthClient.verifyIdToken({
    idToken: identityToken,
    audience: googleAuthConfig.clientId
  });
  const googlePayload = ticket.getPayload();

  if (!googlePayload) {
    throw new Error('Google token payload is missing.');
  }

  const isIssuerValid = googleAuthConfig.tokenIssuers.includes(googlePayload.iss || '');
  if (!isIssuerValid) {
    throw new Error('Invalid Google token issuer.');
  }

  return googlePayload;
}

type SmartAccountCreationResult = {
  walletAddress: string;
  ownerAddress: string | null;
  encryptedOwnerPrivateKey: string | null;
};

/**
 * Hàm tạo dữ liệu Smart Account.
 * Mục đích: khởi tạo ví ERC-4337 và trả thêm owner key đã mã hóa để backend thực thi one-click.
 */
async function createSmartAccountProvision(): Promise<SmartAccountCreationResult> {
  const createdSmartAccount = await createZeroDevSmartAccount();
  return {
    walletAddress: createdSmartAccount.smartAccountAddress,
    ownerAddress: createdSmartAccount.ownerAddress,
    encryptedOwnerPrivateKey: createdSmartAccount.encryptedOwnerPrivateKey
  };
}

/**
 * Hàm tạo địa chỉ ví dự phòng theo định dạng EVM.
 * Mục đích: vẫn hoàn tất đăng ký trong môi trường dev khi ZeroDev tạm thời lỗi cấu hình.
 */
function createFallbackWalletAddress(): string {
  const walletHex = crypto.randomBytes(20).toString('hex');
  return `0x${walletHex}`.toLowerCase();
}

/**
 * Hàm tạo Smart Account có fallback an toàn cho dev.
 * Mục đích: ngăn toàn bộ luồng login bị fail bởi lỗi hạ tầng ZeroDev không liên quan Google token.
 */
async function createSmartAccountWithFallback(): Promise<SmartAccountCreationResult> {
  try {
    return await createSmartAccountProvision();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown ZeroDev error';

    // Ghi chú logic phức tạp: chỉ fallback ở môi trường development để tránh làm lệch hành vi production.
    if (process.env.NODE_ENV === 'development') {
      const fallbackWalletAddress = createFallbackWalletAddress();
      logger.warn('ZeroDev unavailable in development, fallback wallet is used.', {
        errorMessage,
        fallbackWalletAddress
      });
      return {
        walletAddress: fallbackWalletAddress,
        ownerAddress: null,
        encryptedOwnerPrivateKey: null
      };
    }

    throw error;
  }
}

/**
 * Hàm đảm bảo user đã có smart account one-click.
 * Mục đích: tự động cấp bổ sung cho user cũ đăng nhập từ trước khi hệ thống lưu owner key mã hóa.
 * Được export để disbursementService gọi khi user chưa có Smart Account.
 */
export async function ensureSmartAccountProvisioned(existingUser: AuthUser): Promise<AuthUser> {
  const hasOneClickSmartAccount = Boolean(existingUser.smartAccountOwnerEncryptedPrivateKey);
  if (hasOneClickSmartAccount) {
    return existingUser;
  }

  const smartAccountCreationResult = await createSmartAccountWithFallback();

  // Ghi chú logic phức tạp: chỉ cập nhật khi có owner key mã hóa hợp lệ để tránh ghi đè dữ liệu bằng fallback null.
  if (!smartAccountCreationResult.encryptedOwnerPrivateKey || !smartAccountCreationResult.ownerAddress) {
    return existingUser;
  }

  return updateUser({
    ...existingUser,
    walletAddress: smartAccountCreationResult.walletAddress,
    smartAccountOwnerAddress: smartAccountCreationResult.ownerAddress,
    smartAccountOwnerEncryptedPrivateKey: smartAccountCreationResult.encryptedOwnerPrivateKey,
    updatedAt: new Date()
  });
}


/**
 * Hàm tạo JWT access token.
 * Mục đích: cấp token ngắn hạn cho xác thực API.
 */
function createAccessToken(payload: Record<string, string | number>): string {
  const signOptions: SignOptions = {
    issuer: jsonWebTokenConfig.issuer,
    audience: jsonWebTokenConfig.audience,
    expiresIn: jsonWebTokenConfig.accessTokenExpiresIn as SignOptions['expiresIn']
  };

  return jsonWebToken.sign(payload, jsonWebTokenSecret, signOptions);
}

/**
 * Hàm tạo chuỗi refresh token.
 * Mục đích: tạo token ngẫu nhiên để làm mới access token.
 */
function createRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Hàm băm refresh token.
 * Mục đích: lưu hash an toàn trong bộ nhớ.
 */
async function hashRefreshToken(refreshToken: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(refreshToken, saltRounds);
}

/**
 * Hàm tạo mã correlationId.
 * Mục đích: phục vụ theo dõi xuyên suốt phiên đăng nhập.
 */
function createCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Hàm chuyển đổi dữ liệu Google thành hồ sơ người dùng.
 * Mục đích: chuẩn hóa dữ liệu đăng nhập.
 */
function buildGoogleUserProfile(googlePayload: TokenPayload): GoogleUserProfile {
  const emailValue = googlePayload.email?.toLowerCase();
  if (!emailValue) {
    throw new Error('Google account does not provide email.');
  }

  return {
    email: emailValue,
    fullName: googlePayload.name || 'Google User',
    socialAccountId: googlePayload.sub || '',
    isEmailVerified: Boolean(googlePayload.email_verified)
  };
}

/**
 * Hàm tạo access token và refresh token.
 * Mục đích: trả về cặp token cùng metadata phiên.
 * [S-NEW2 fix] Thêm authVersion vào JWT payload
 */
async function generateTokenPair(user: AuthUser, ipAddress: string, userAgent: string) {
  const accessTokenPayload = {
    userId: user.id,
    email: user.email,
    walletAddress: user.walletAddress,
    role: user.role,
    authVersion: user.authVersion ?? 1 // Embed authVersion vào JWT
  };

  const accessToken = createAccessToken(accessTokenPayload);
  const refreshToken = createRefreshToken();
  const refreshTokenHash = await hashRefreshToken(refreshToken);
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + refreshTokenExpirationMs);
  const now = new Date();

  await createRefreshSession({
    id: sessionId,
    userId: user.id,
    refreshTokenHash,
    csrfToken,
    ipAddress,
    userAgent,
    expiresAt,
    failedRefreshCount: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now
  });

  return {
    accessToken,
    refreshToken,
    csrfToken,
    sessionId,
    expiresAt
  };
}

/**
 * Hàm ghi audit log đăng nhập.
 * Mục đích: lưu dấu vết đăng nhập thất bại hoặc thiết bị mới.
 */
async function logAuthEvent(entry: AuditLogEntry): Promise<void> {
  await addAuditLog(entry);
}

/**
 * Hàm ghi audit log khi đăng nhập Google thất bại.
 * Mục đích: phục vụ truy vết hành vi đăng nhập không hợp lệ.
 */
export function logFailedGoogleLogin(
  email: string | null,
  ipAddress: string,
  userAgent: string,
  detail: string
): void {
  logAuthEvent({
    id: crypto.randomUUID(),
    userId: null,
    email,
    eventType: 'GOOGLE_LOGIN_FAILED',
    ipAddress,
    userAgent,
    detail,
    createdAt: new Date()
  }).catch(() => undefined);
}

/**
 * Hàm thu hồi toàn bộ refresh session của người dùng.
 * Mục đích: đăng xuất khỏi tất cả thiết bị.
 */
export async function revokeAllRefreshSessionsForUser(userId: string): Promise<void> {
  await revokeRefreshSessionsByUserId(userId);
}

/**
 * Hàm kiểm tra thiết bị mới.
 * Mục đích: ghi log khi đăng nhập bằng IP/User-Agent khác trước.
 */
function handleNewDeviceLogin(user: AuthUser, ipAddress: string, userAgent: string): void {
  const isNewDevice = user.lastLoginIp !== ipAddress || user.lastLoginUserAgent !== userAgent;
  if (isNewDevice) {
    logAuthEvent({
      id: crypto.randomUUID(),
      userId: user.id,
      email: user.email,
      eventType: 'NEW_DEVICE_LOGIN',
      ipAddress,
      userAgent,
      detail: 'Đăng nhập từ thiết bị mới',
      createdAt: new Date()
    }).catch(() => undefined);
  }
}

/**
 * Hàm xử lý đăng nhập bằng Google.
 * Mục đích: tạo hoặc cập nhật người dùng theo vai trò và trả về access/refresh token.
 */
export async function loginWithGoogle(
  identityToken: string,
  role: 'donor' | 'organization',
  ipAddress: string,
  userAgent: string
) {
  const googlePayload = await verifyGoogleIdentityToken(identityToken);
  const userProfile = buildGoogleUserProfile(googlePayload);
  const correlationId = createCorrelationId();
  const isOrganizationRegistrationRequest = role === 'organization';
  const initialUserRole = isOrganizationRegistrationRequest ? 'donor' : role;
  const initialAccountStatus = isOrganizationRegistrationRequest ? 'INACTIVE_PENDING_KYC' : 'ACTIVE';

  const existingUser = await findUserByEmail(userProfile.email);
  let authenticatedUser: AuthUser;

  if (!existingUser) {
    try {
      const smartAccountCreationResult = await createSmartAccountWithFallback();
      authenticatedUser = await createUser({
        id: crypto.randomUUID(),
        email: userProfile.email,
        fullName: userProfile.fullName,
        // Ghi chú logic phức tạp: đăng ký tổ chức chỉ tạo hồ sơ chờ KYC, không cấp quyền organization trước khi duyệt.
        role: initialUserRole,
        walletAddress: smartAccountCreationResult.walletAddress,
        smartAccountOwnerAddress: smartAccountCreationResult.ownerAddress,
        smartAccountOwnerEncryptedPrivateKey: smartAccountCreationResult.encryptedOwnerPrivateKey,
        socialProvider: 'google',
        socialAccountId: userProfile.socialAccountId,
        isEmailVerified: userProfile.isEmailVerified,
        accountStatus: initialAccountStatus,
        organizationName: null,
        legalRegistrationNumber: null,
        isSybil: false,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lastLoginUserAgent: userAgent,
        correlationId,
        fcmDeviceToken: null,
        phoneNumber: null,
        authVersion: 1
      });
    } catch (error) {
      // Logic phức tạp: xử lý trường hợp tạo user đồng thời gây lỗi trùng email, chuyển sang luồng đăng nhập.
      if (!isDuplicateMongoError(error)) {
        throw error;
      }

      const duplicatedUser = await findUserByEmail(userProfile.email);
      if (!duplicatedUser) {
        throw error;
      }

      handleNewDeviceLogin(duplicatedUser, ipAddress, userAgent);
      authenticatedUser = await updateUser({
        ...duplicatedUser,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lastLoginUserAgent: userAgent,
        correlationId
      });
    }
  } else {
    handleNewDeviceLogin(existingUser, ipAddress, userAgent);

    // Ghi chú logic phức tạp: user cũ có thể chưa có owner key mã hóa, cần tự động cấp để dùng flow one-click donation.
    const userAfterSmartAccountProvision = await ensureSmartAccountProvisioned(existingUser);

    // Ghi chú logic phức tạp: với tài khoản đã tồn tại, hệ thống luôn lấy role từ DB làm nguồn sự thật.
    // Cách này cho phép tài khoản regulatory/admin đăng nhập ổn định ngay cả khi FE gửi role mặc định donor.
    // Đồng thời vẫn không làm thay đổi role trong DB, nên không phát sinh nâng quyền trái phép từ client.
    authenticatedUser = await updateUser({
      ...userAfterSmartAccountProvision,
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress,
      lastLoginUserAgent: userAgent,
      correlationId
    });
  }

  const tokenPair = await generateTokenPair(authenticatedUser, ipAddress, userAgent);

  return {
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    csrfToken: tokenPair.csrfToken,
    refreshSessionId: tokenPair.sessionId,
    expiresAt: tokenPair.expiresAt,
    user: {
      id: authenticatedUser.id,
      email: authenticatedUser.email,
      fullName: authenticatedUser.fullName,
      walletAddress: authenticatedUser.walletAddress,
      role: authenticatedUser.role,
      accountStatus: authenticatedUser.accountStatus
    },
    correlationId
  };
}

/**
 * Hàm làm mới access token.
 * Mục đích: xác thực refresh token và cấp token mới.
 */
export async function refreshAccessToken(
  refreshSessionId: string,
  refreshToken: string,
  csrfToken: string,
  ipAddress: string,
  userAgent: string
) {
  const existingSession = await findRefreshSessionById(refreshSessionId);

  if (!existingSession) {
    throw new Error('Refresh session not found.');
  }

  const now = new Date();
  if (existingSession.expiresAt <= now) {
    await revokeRefreshSession(existingSession.id);
    throw new Error('Refresh session expired.');
  }

  if (existingSession.lockedUntil && existingSession.lockedUntil > now) {
    throw new Error('Refresh session is locked.');
  }

  if (existingSession.ipAddress !== ipAddress || existingSession.userAgent !== userAgent) {
    await logAuthEvent({
      id: crypto.randomUUID(),
      userId: existingSession.userId,
      email: null,
      eventType: 'REFRESH_DEVICE_MISMATCH',
      ipAddress,
      userAgent,
      detail: 'Thông tin thiết bị không khớp khi refresh token',
      createdAt: new Date()
    });
    throw new Error('Device metadata mismatch.');
  }

  if (existingSession.csrfToken !== csrfToken) {
    throw new Error('Invalid CSRF token.');
  }

  const isRefreshTokenValid = await bcrypt.compare(refreshToken, existingSession.refreshTokenHash);
  if (!isRefreshTokenValid) {
    const updatedFailedCount = existingSession.failedRefreshCount + 1;
    const maxFailedAttempts = 5;
    const lockoutDurationMs = 15 * 60 * 1000;
    const isLocked = updatedFailedCount >= maxFailedAttempts;
    const lockedUntil = isLocked ? new Date(Date.now() + lockoutDurationMs) : null;

    // Logic chống brute-force: tăng số lần sai và khóa tạm thời khi vượt ngưỡng.
    await updateRefreshSession({
      ...existingSession,
      failedRefreshCount: updatedFailedCount,
      lockedUntil,
      updatedAt: new Date()
    });

    await logAuthEvent({
      id: crypto.randomUUID(),
      userId: existingSession.userId,
      email: null,
      eventType: 'REFRESH_TOKEN_FAILED',
      ipAddress,
      userAgent,
      detail: 'Refresh token không hợp lệ',
      createdAt: new Date()
    });

    throw new Error('Invalid refresh token.');
  }

  const userData = await findUserById(existingSession.userId);
  if (!userData) {
    throw new Error('User not found.');
  }

  const newAccessToken = createAccessToken({
    userId: userData.id,
    email: userData.email,
    walletAddress: userData.walletAddress,
    role: userData.role,
    authVersion: userData.authVersion ?? 1 // [S-NEW2 fix] Thêm authVersion vào refreshed token
  });

  const rotatedRefreshToken = createRefreshToken();
  const rotatedRefreshTokenHash = await hashRefreshToken(rotatedRefreshToken);
  const updatedAt = new Date();

  await updateRefreshSession({
    ...existingSession,
    refreshTokenHash: rotatedRefreshTokenHash,
    failedRefreshCount: 0,
    lockedUntil: null,
    updatedAt
  });

  return {
    accessToken: newAccessToken,
    refreshToken: rotatedRefreshToken,
    csrfToken: existingSession.csrfToken,
    refreshSessionId: existingSession.id,
    expiresAt: existingSession.expiresAt
  };
}

export type ActiveSessionView = {
  sessionId: string;
  deviceLabel: string;
  ipAddress: string;
  loggedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
};

/** Hàm rút gọn user-agent thành nhãn thiết bị dễ đọc. Mục đích: hiển thị thân thiện trên giao diện bảo mật. */
function buildDeviceLabelFromUserAgent(userAgent: string): string {
  if (!userAgent || userAgent === 'unknown') {
    return 'Thiết bị không xác định';
  }

  const normalizedUserAgent = userAgent.toLowerCase();

  if (normalizedUserAgent.includes('iphone')) {
    return 'Mobile · iPhone';
  }

  if (normalizedUserAgent.includes('android')) {
    return 'Mobile · Android';
  }

  if (normalizedUserAgent.includes('windows')) {
    return 'Web · Windows';
  }

  if (normalizedUserAgent.includes('mac os') || normalizedUserAgent.includes('macintosh')) {
    return 'Web · macOS';
  }

  if (normalizedUserAgent.includes('linux')) {
    return 'Web · Linux';
  }

  return 'Thiết bị khác';
}

/** Hàm lấy danh sách phiên đăng nhập đang hoạt động của user. Mục đích: trả dữ liệu thật cho tab cài đặt bảo mật. */
export async function getMyActiveSessions(userId: string): Promise<ActiveSessionView[]> {
  const refreshSessionList = await getActiveRefreshSessionsByUserId(userId);

  return refreshSessionList.map(refreshSession => ({
    sessionId: refreshSession.id,
    deviceLabel: buildDeviceLabelFromUserAgent(refreshSession.userAgent),
    ipAddress: refreshSession.ipAddress,
    loggedInAt: refreshSession.createdAt.toISOString(),
    lastActiveAt: refreshSession.updatedAt.toISOString(),
    expiresAt: refreshSession.expiresAt.toISOString()
  }));
}


