import { NextFunction, Request, Response } from 'express';
import jsonWebToken from 'jsonwebtoken';
import { getJsonWebTokenConfig, getJsonWebTokenSecret } from '../config/jsonWebToken';
import { findUserById } from '../models/authModel';
import { setRequestUser } from '../config/requestContext';
import { sendErrorResponse } from '../utils/apiResponse';
import { extractBearerToken } from '../utils/tokenExtractor';
import { isAuthorizedAdminLoginWallet } from '../config/adminAccess';

type JwtClaims = {
  userId: string;
  role: string;
  authVersion?: number;
};

type AuthenticatedRequest = Request & {
  authenticatedUser?: JwtClaims;
};

const GOVERNANCE_SENSITIVE_ROLES = new Set(['admin', 'executive_chair', 'executive_member']);

/** Tạo middleware xác thực JWT và kiểm tra lại tài khoản quản trị để việc thu quyền có hiệu lực tức thời. */
export function createAuthenticationMiddleware() {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    const bearerToken = extractBearerToken(request.headers.authorization);
    if (!bearerToken) {
      sendErrorResponse(response, 401, 'Thiếu access token hợp lệ.', 'UNAUTHENTICATED');
      return;
    }

    if (!attachVerifiedUserSafely(request, response, bearerToken)) return;
    if (!await ensureGovernanceTokenFreshness(request.authenticatedUser, response)) return;
    next();
  };
}

/** Tạo middleware xác thực tùy chọn, vẫn chặn JWT quản trị đã bị thu hồi nếu request gửi token. */
export function createOptionalAuthenticationMiddleware() {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    const bearerToken = extractBearerToken(request.headers.authorization);
    if (!bearerToken) {
      next();
      return;
    }

    if (!attachVerifiedUserSafely(request, response, bearerToken)) return;
    if (!await ensureGovernanceTokenFreshness(request.authenticatedUser, response)) return;
    next();
  };
}

/** Xác minh JWT và gắn claims đã kiểm tra vào request context. */
function attachVerifiedUser(request: AuthenticatedRequest, bearerToken: string): void {
  const jwtSecret = getJsonWebTokenSecret();
  const jsonWebTokenConfig = getJsonWebTokenConfig();
  const decodedPayload = jsonWebToken.verify(bearerToken, jwtSecret, {
    issuer: jsonWebTokenConfig.issuer,
    audience: jsonWebTokenConfig.audience,
    algorithms: ['HS256']
  }) as JwtClaims;
  request.authenticatedUser = {
    userId: decodedPayload.userId,
    role: decodedPayload.role,
    authVersion: decodedPayload.authVersion ?? 1
  };
  setRequestUser(decodedPayload.userId);
}

/** Chuyển lỗi xác minh chữ ký JWT thành response thống nhất trước khi truy vấn trạng thái quyền. */
function attachVerifiedUserSafely(request: AuthenticatedRequest, response: Response, bearerToken: string): boolean {
  try {
    attachVerifiedUser(request, bearerToken);
    return true;
  } catch {
    sendErrorResponse(response, 401, 'Access token không hợp lệ hoặc đã hết hạn.', 'UNAUTHENTICATED');
    return false;
  }
}

/** Kiểm tra lại token của role quản trị trên DB để JWT cũ không vượt qua sau khi ghế bị suspend hay role đổi. */
async function ensureGovernanceTokenFreshness(claims: JwtClaims | undefined, response: Response): Promise<boolean> {
  if (!claims || !GOVERNANCE_SENSITIVE_ROLES.has(claims.role)) return true;
  try {
    const user = await findUserById(claims.userId);
    if (!user || user.accountStatus !== 'ACTIVE' || user.isSybil || user.authVersion !== (claims.authVersion ?? 1) || user.role !== claims.role
      // Defense-in-depth: access token admin cũ cũng không vượt qua cho đến khi hết hạn sau khi ví bị thu quyền.
      || (user.role === 'admin' && !isAuthorizedAdminLoginWallet(user.governanceWalletAddress))) {
      sendErrorResponse(response, 401, 'Phiên đăng nhập đã bị thu hồi hoặc không còn hợp lệ.', 'UNAUTHENTICATED');
      return false;
    }
    return true;
  } catch {
    sendErrorResponse(response, 503, 'Không thể xác minh quyền quản trị. Vui lòng thử lại sau.', 'AUTHORIZATION_UNAVAILABLE');
    return false;
  }
}

export type { AuthenticatedRequest };
