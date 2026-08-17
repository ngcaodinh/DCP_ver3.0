import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  isPublicApiRoute,
  isPublicSseRoute,
  isGuestApiRoute,
  isPersonalizedRankingRequest,
  applySeoAndCacheHeaders
} from '../../middleware/seoCacheMiddleware';
import { API_GUEST_PREFIX } from '../../config/apiPrefixes';

const makeMockRequest = (
  path: string,
  method = 'GET',
  query: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Request => {
  const req = { path, method, query, headers } as unknown as Request;
  return req;
};

describe('isPublicApiRoute', () => {
  it('should return true for /health path', () => {
    expect(isPublicApiRoute(makeMockRequest('/health'))).toBe(true);
  });

  it('should return true for /projects path', () => {
    expect(isPublicApiRoute(makeMockRequest('/projects'))).toBe(true);
  });

  it('should return true for /donations path', () => {
    expect(isPublicApiRoute(makeMockRequest('/donations'))).toBe(true);
  });

  it('should return true for /rankings path', () => {
    expect(isPublicApiRoute(makeMockRequest('/rankings'))).toBe(true);
  });

  it('should return false for /api/guest path', () => {
    expect(isPublicApiRoute(makeMockRequest('/api/guest/session'))).toBe(false);
  });

  it('should return false for /api/admin path', () => {
    expect(isPublicApiRoute(makeMockRequest('/api/admin/dashboard'))).toBe(false);
  });

  it('should return false for unrelated paths', () => {
    expect(isPublicApiRoute(makeMockRequest('/auth/login'))).toBe(false);
    expect(isPublicApiRoute(makeMockRequest('/unknown'))).toBe(false);
  });

  it('should return true for nested public paths', () => {
    expect(isPublicApiRoute(makeMockRequest('/projects/abc/donate'))).toBe(true);
    expect(isPublicApiRoute(makeMockRequest('/donations/live-feed/stream'))).toBe(true);
  });
});

describe('isPublicSseRoute', () => {
  it('should return true for donations live-feed stream', () => {
    expect(isPublicSseRoute(makeMockRequest('/donations/live-feed/stream'))).toBe(true);
  });

  it('should return false for regular donations path', () => {
    expect(isPublicSseRoute(makeMockRequest('/donations'))).toBe(false);
  });

  it('should return false for guest API routes', () => {
    expect(isPublicSseRoute(makeMockRequest('/api/guest/session'))).toBe(false);
  });

  it('should return false for unrelated SSE-like paths', () => {
    expect(isPublicSseRoute(makeMockRequest('/notifications/stream'))).toBe(false);
  });
});

describe('isGuestApiRoute', () => {
  it('should return true for /api/guest/session', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/session'))).toBe(true);
  });

  it('should return true for /api/guest/claim/prepare', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/claim/prepare'))).toBe(true);
  });

  it('should return true for /api/guest/paymaster/sponsor', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/paymaster/sponsor'))).toBe(true);
  });

  it('should return true for /guest/session/refresh', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/session/refresh'))).toBe(true);
  });

  it('should return true for /guest/session/status', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/session/status'))).toBe(true);
  });

  it('should return true for /guest/pending-donation', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/pending-donation'))).toBe(true);
  });

  it('should return true for /guest/pending-donation/clear', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/pending-donation/clear'))).toBe(true);
  });

  it('should return true for /guest/claim/execute', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/claim/execute'))).toBe(true);
  });

  it('should return true for /guest/claim/partial', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/guest/claim/partial'))).toBe(true);
  });

  it('should return false for /guest/session (no /api prefix)', () => {
    expect(isGuestApiRoute(makeMockRequest('/guest/session'))).toBe(false);
  });

  it('should return false for regular API routes', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/deposit'))).toBe(false);
    expect(isGuestApiRoute(makeMockRequest('/api/projects'))).toBe(false);
  });

  it('should return false for admin routes', () => {
    expect(isGuestApiRoute(makeMockRequest('/api/admin/dashboard'))).toBe(false);
  });

  // Contract guard: nếu ai refactor mount order trong app.ts mà accidentally
  // strip /api prefix trước khi middleware chạy, test này sẽ fail.
  // isGuestApiRoute phụ thuộc vào request.path chứa đầy đủ /api/guest prefix.
  it('should use API_GUEST_PREFIX constant for consistency with app.ts mount point', () => {
    // Lấy prefix từ config để verify isGuestApiRoute dùng cùng nguồn
    const req = makeMockRequest(`${API_GUEST_PREFIX}/session/refresh`);
    expect(isGuestApiRoute(req)).toBe(true);
  });
});

describe('applySeoAndCacheHeaders routing priority', () => {
  let mockResponse: { setHeader: ReturnType<typeof vi.fn>; };
  let nextFn: NextFunction;
  let setHeaderMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setHeaderMock = vi.fn();
    mockResponse = {
      setHeader: setHeaderMock
    };
    nextFn = vi.fn();
  });

  // === Priority 1: Guest API routes — NO cache ===

  it('should set no-store headers for /api/guest/session (POST)', () => {
    const req = makeMockRequest('/api/guest/session', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/session/refresh (POST)', () => {
    const req = makeMockRequest('/api/guest/session/refresh', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/session/status (GET)', () => {
    const req = makeMockRequest('/api/guest/session/status', 'GET');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/pending-donation (GET)', () => {
    const req = makeMockRequest('/api/guest/pending-donation', 'GET');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/pending-donation/clear (POST)', () => {
    const req = makeMockRequest('/api/guest/pending-donation/clear', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/paymaster/sponsor (POST)', () => {
    const req = makeMockRequest('/api/guest/paymaster/sponsor', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/claim/prepare (POST)', () => {
    const req = makeMockRequest('/api/guest/claim/prepare', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/claim/execute (POST)', () => {
    const req = makeMockRequest('/api/guest/claim/execute', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store headers for /api/guest/claim/partial (POST)', () => {
    const req = makeMockRequest('/api/guest/claim/partial', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  // Contract guard: verify guest routes KHÔNG bao giờ nhận public cache
  // Nếu isGuestApiRoute bị broken (ví dụ: logic bị đổi sang dùng baseUrl thay vì prefix),
  // test này sẽ fail thay vì silently gây cache dữ liệu nhạy cảm.
  it('should NEVER set public cache for any guest API route', () => {
    const guestPaths = [
      '/api/guest/session',
      '/api/guest/session/refresh',
      '/api/guest/session/status',
      '/api/guest/pending-donation',
      '/api/guest/pending-donation/clear',
      '/api/guest/paymaster/sponsor',
      '/api/guest/claim/prepare',
      '/api/guest/claim/execute',
      '/api/guest/claim/partial'
    ];
    for (const path of guestPaths) {
      setHeaderMock.mockClear();
      const req = makeMockRequest(path, 'GET');
      applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
      expect(setHeaderMock).not.toHaveBeenCalledWith('Cache-Control', expect.stringContaining('public'));
    }
  });

  it('should set SSE buffering headers for public SSE route (priority 2)', () => {
    const req = makeMockRequest('/donations/live-feed/stream');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(setHeaderMock).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set public cache headers for GET public API routes (priority 3)', () => {
    const req = makeMockRequest('/projects', 'GET');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should prevent shared cache for ranking requests with donorAddress', () => {
    const req = makeMockRequest(
      '/rankings/trust-adjusted',
      'GET',
      { donorAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' }
    );

    expect(isPersonalizedRankingRequest(req)).toBe(true);
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(setHeaderMock).toHaveBeenCalledWith('Vary', 'Authorization');
    expect(setHeaderMock).not.toHaveBeenCalledWith('Cache-Control', expect.stringContaining('public'));
  });

  it('should prevent shared cache for authenticated public ranking requests', () => {
    const req = makeMockRequest('/rankings/trust-adjusted', 'GET', {}, { authorization: 'Bearer token' });

    expect(isPersonalizedRankingRequest(req)).toBe(true);
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(setHeaderMock).toHaveBeenCalledWith('Vary', 'Authorization');
  });

  it('should NOT set public cache for non-GET public API routes', () => {
    const req = makeMockRequest('/projects', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).not.toHaveBeenCalledWith('Cache-Control', expect.stringContaining('public'));
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should set no-store for all other routes (fallback)', () => {
    const req = makeMockRequest('/auth/login', 'POST');
    applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);

    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(nextFn).toHaveBeenCalled();
  });

  it('should always set X-Robots-Tag on every request', () => {
    const routes = [
      makeMockRequest('/api/guest/session'),
      makeMockRequest('/donations/live-feed/stream'),
      makeMockRequest('/projects', 'GET'),
      makeMockRequest('/unknown', 'GET')
    ];

    for (const req of routes) {
      setHeaderMock.mockClear();
      applySeoAndCacheHeaders(req, mockResponse as unknown as Response, nextFn);
      expect(setHeaderMock).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
  });
});
