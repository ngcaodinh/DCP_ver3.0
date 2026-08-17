import { NextFunction, Request, Response } from 'express';
import jsonWebToken from 'jsonwebtoken';
import { getJsonWebTokenConfig, getJsonWebTokenSecret } from '../config/jsonWebToken';
import { sendErrorResponse } from '../utils/apiResponse';
import { extractBearerToken } from '../utils/tokenExtractor';
import { setRequestUser } from '../config/requestContext';

type JwtClaims = {
  userId: string;
  role: string;
  authVersion?: number;
};

type AuthenticatedRequest = Request & {
  authenticatedUser?: JwtClaims;
};

/**
 * Hàm tạo middleware xác thực JWT.
 * Mục đích: bảo vệ endpoint yêu cầu người dùng đăng nhập hợp lệ.
 */
export function createAuthenticationMiddleware() {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(request.headers.authorization);

    if (!bearerToken) {
      sendErrorResponse(response, 401, 'Thiếu access token hợp lệ.', 'UNAUTHENTICATED');
      return;
    }

    try {
      attachVerifiedUser(request, bearerToken);
      next();
    } catch {
      sendErrorResponse(response, 401, 'Access token không hợp lệ hoặc đã hết hạn.', 'UNAUTHENTICATED');
    }
  };
}

/**
 * Xác thực tùy chọn cho endpoint vừa công khai vừa có dữ liệu cá nhân.
 * Không có token thì cho request public đi qua; token sai vẫn bị từ chối.
 */
export function createOptionalAuthenticationMiddleware() {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const bearerToken = extractBearerToken(request.headers.authorization);

    if (!bearerToken) {
      next();
      return;
    }

    try {
      attachVerifiedUser(request, bearerToken);
      next();
    } catch {
      sendErrorResponse(response, 401, 'Access token không hợp lệ hoặc đã hết hạn.', 'UNAUTHENTICATED');
    }
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

export type { AuthenticatedRequest };
