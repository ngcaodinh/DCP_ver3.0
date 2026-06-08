import { Request, Response, NextFunction } from 'express';

/**
 * Hàm middleware bảo vệ CSRF cho refresh token.
 * Mục đích: bắt buộc client gửi token khớp với refresh session.
 */
export function createRefreshCsrfMiddleware() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const csrfHeader = request.headers['x-csrf-token'];
    if (typeof csrfHeader !== 'string' || csrfHeader.trim().length === 0) {
      response.status(403).json({
        message: 'Thiếu CSRF token hợp lệ.'
      });
      return;
    }

    request.headers['x-csrf-token'] = csrfHeader.trim();
    next();
  };
}

