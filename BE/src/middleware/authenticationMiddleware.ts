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
      next();
    } catch {
      sendErrorResponse(response, 401, 'Access token không hợp lệ hoặc đã hết hạn.', 'UNAUTHENTICATED');
    }
  };
}

export type { AuthenticatedRequest };
