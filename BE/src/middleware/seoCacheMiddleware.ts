import { Request, Response, NextFunction } from 'express';
import { API_GUEST_PREFIX } from '../config/apiPrefixes';

/**
 * Kiểm tra request có phải API công khai hay không.
 * Mục đích: áp dụng cache và X-Robots-Tag đúng phạm vi cần thiết.
 * Giả định: middleware được mount ở root app (request.path là full path).
 * Nếu refactor thành sub-router, cần cập nhật logic ở đây.
 */
// IMPORTANT: Khi thêm route public mới vào app.ts, nhớ cập nhật danh sách này.
const PUBLIC_CACHEABLE_ROUTE_PREFIXES = ['/health', '/projects', '/donations', '/rankings'] as const;

export function isPublicApiRoute(request: Request): boolean {
  return PUBLIC_CACHEABLE_ROUTE_PREFIXES.some(prefix => request.path.startsWith(prefix));
}

/**
 * Kiểm tra request có phải SSE public hay không.
 * Mục đích: tắt cache/buffering cho stream realtime để tránh trễ dữ liệu.
 */
export function isPublicSseRoute(request: Request): boolean {
  return request.path === '/donations/live-feed/stream';
}

/**
 * Hàm kiểm tra request có phải guest API hay không.
 * Mục đích: áp dụng Cache-Control no-store cho guest endpoints để tránh lưu cache dữ liệu nhạy cảm.
 * Sử dụng API_GUEST_PREFIX từ config để đảm bảo đồng nhất với mount point ở app.ts.
 */
export function isGuestApiRoute(request: Request): boolean {
  // Exact match cho GET /api/guest (nếu có), startsWith cho tất cả sub-routes /api/guest/*
  return request.path.startsWith(API_GUEST_PREFIX + '/') || request.path === API_GUEST_PREFIX;
}

/** Kiểm tra ranking request có chứa dữ liệu cá nhân cần cấm shared cache hay không. */
export function isPersonalizedRankingRequest(request: Request): boolean {
  return request.path === '/rankings/trust-adjusted'
    && (Boolean(request.query?.donorAddress) || Boolean(request.headers.authorization));
}

/**
 * Gắn header SEO và cache cho API.
 * Mục đích: ngăn index endpoint nhạy cảm và tối ưu cache cho dữ liệu công khai phù hợp.
 * X-Robots-Tag được set cho mọi request (kể cả public routes) vì đây là API, không cần SEO.
 */
export function applySeoAndCacheHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (isGuestApiRoute(request)) {
    // Guest session data không được cache — chỉ cần Cache-Control no-store
    // Theo RFC 7234, no-store là directive duy nhất cần thiết để ngăn lưu cache.
    // Surrogate-Control chỉ cần thiết khi có CDN layer (Varnish/Fastly) — hiện tại không có trong stack.
    response.setHeader('Cache-Control', 'no-store');
  } else if (isPublicSseRoute(request)) {
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
  } else if (isPersonalizedRankingRequest(request)) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Authorization');
  } else if (request.method === 'GET' && isPublicApiRoute(request)) {
    response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    // Vary: phòng ngừa CDN cache sai khi Accept-Language hoặc Accept thay đổi
    response.setHeader('Vary', 'Accept-Encoding, Accept');
  } else {
    response.setHeader('Cache-Control', 'no-store');
  }

  next();
}
