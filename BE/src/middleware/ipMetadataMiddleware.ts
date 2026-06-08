import { Request, Response, NextFunction } from 'express';

/**
 * Hàm middleware chuẩn hóa metadata IP và User-Agent.
 * Mục đích: lưu thông tin thiết bị phục vụ bảo mật refresh token.
 */
export function attachRequestMetadata() {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const clientIp = request.ip || request.headers['x-forwarded-for']?.toString() || 'unknown';
    const userAgent = request.headers['user-agent'] || 'unknown';

    request.headers['x-client-ip'] = clientIp;
    request.headers['x-client-user-agent'] = userAgent;
    next();
  };
}

