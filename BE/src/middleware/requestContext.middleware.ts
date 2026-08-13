/**
 * Middleware sinh và gắn HTTP correlation ID cho mỗi request.
 * Mục đích: mọi request, kể cả request bị CORS từ chối, đều có ID để truy vết.
 * Middleware này phải được đăng ký trước CORS trong app.ts.
 */
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../config/requestContext';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve correlation ID từ header hợp lệ hoặc sinh UUID v4 mới.
 * Mục đích: chặn newline và input quá dài để tránh log injection.
 */
function resolveRequestId(request: Request): string {
  const incomingHeader = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;

  const isAcceptable =
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID_PATTERN.test(candidate);

  return isAcceptable ? candidate : randomUUID();
}

/**
 * Gắn correlation ID vào AsyncLocalStorage trong toàn bộ vòng đời request.
 * Mục đích: echo header về client và cho logger tự đọc context hiện tại.
 */
export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  let requestId: string;

  try {
    requestId = resolveRequestId(request);
    response.setHeader('X-Request-ID', requestId);
  } catch {
    // Observability là best-effort; lỗi tạo context không được chặn request nghiệp vụ.
    next();
    return;
  }

  runWithRequestContext({ requestId, userId: null }, next);
}
