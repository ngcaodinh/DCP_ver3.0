import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  getMetricsAuthToken,
  isMetricsAuthOptionalEnvironment,
  isValidMetricsAuthToken
} from '../config/metricsAuthConfig';
import { sendErrorResponse } from '../utils/apiResponse';

const BEARER_PREFIX = 'Bearer ';

/** So sánh bearer token của Prometheus bằng constant-time comparison để giảm rủi ro timing attack. */
function hasValidMetricsToken(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) return false;

  const providedToken = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  const providedBuffer = Buffer.from(providedToken, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Tạo middleware bảo vệ endpoint metrics bằng Authorization: Bearer <METRICS_AUTH_TOKEN>. */
export function createMetricsAuthMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const expectedToken = getMetricsAuthToken();

    // Chỉ development/test được bypass; staging hoặc môi trường lạ không được vô tình mở endpoint.
    if (!expectedToken && isMetricsAuthOptionalEnvironment()) {
      next();
      return;
    }

    if (!expectedToken
      || !isValidMetricsAuthToken(expectedToken)
      || !hasValidMetricsToken(request.headers.authorization, expectedToken)) {
      sendErrorResponse(response, 401, 'Thiếu hoặc sai metrics token.', 'UNAUTHENTICATED');
      return;
    }

    next();
  };
}
