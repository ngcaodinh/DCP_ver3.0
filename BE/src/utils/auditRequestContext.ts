import type { Request } from 'express';

/** Context HTTP tối thiểu được phép chuyển từ controller vào audit service. */
export interface AuditRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Trích xuất context request theo cấu hình trust proxy của Express.
 * Chỉ dùng request.ip để tránh tin trực tiếp header X-Forwarded-For do client gửi.
 */
export function extractAuditRequestContext(request: Request): AuditRequestContext {
  const userAgentHeader = typeof request.get === 'function'
    ? request.get('user-agent')
    : request.headers?.['user-agent'];
  const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader.trim() : null;
  return {
    ipAddress: request.ip?.trim() || null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null
  };
}
