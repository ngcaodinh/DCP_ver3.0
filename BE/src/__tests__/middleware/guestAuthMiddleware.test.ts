import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { createGuestAuthMiddleware, GuestSessionRequest } from '../../middleware/guestAuthMiddleware';
import * as guestJsonWebToken from '../../config/guestJsonWebToken';
import * as guestWalletSessionRepository from '../../repositories/guestWalletSessionRepository';

vi.mock('../../config/guestJsonWebToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/guestJsonWebToken')>();
  return {
    ...actual,
    verifyGuestSessionToken: vi.fn()
  };
});

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionById: vi.fn(),
  updateGuestWalletSession: vi.fn().mockResolvedValue(null)
}));

describe('guestAuthMiddleware', () => {
  let mockRequest: Partial<GuestSessionRequest>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;
  let jsonMock: typeof import('jsonwebtoken');

  beforeEach(async () => {
    vi.clearAllMocks();

    mockRequest = {
      headers: {}
    };

    mockResponse = {
      status: vi.fn().mockReturnThis() as Response['status'],
      json: vi.fn().mockReturnThis() as Response['json']
    };

    nextFunction = vi.fn();

    const jwt = await import('jsonwebtoken');
    jsonMock = jwt;
  });

  // -------------------------------------------------------------------------
  // GUEST_TOKEN_REQUIRED — missing authorization header
  // -------------------------------------------------------------------------
  describe('missing authorization header', () => {
    it('trả về 401 GUEST_TOKEN_REQUIRED khi không có header Authorization', async () => {
      mockRequest.headers = {};

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'GUEST_TOKEN_REQUIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('trả về 401 khi Authorization header không có Bearer prefix', async () => {
      mockRequest.headers = { authorization: 'Basic sometoken' };

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_TOKEN_REQUIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('trả về 401 khi Authorization header là Bearer rỗng', async () => {
      mockRequest.headers = { authorization: 'Bearer ' };

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GUEST_TOKEN_INVALID — malformed token
  // -------------------------------------------------------------------------
  describe('invalid token', () => {
    it('trả về 401 GUEST_TOKEN_INVALID khi token không decode được', async () => {
      mockRequest.headers = { authorization: 'Bearer invalid.token.here' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new jsonMock.JsonWebTokenError('invalid signature');
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_TOKEN_INVALID'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('trả về 401 GUEST_TOKEN_INVALID khi token đã hết hạn', async () => {
      mockRequest.headers = { authorization: 'Bearer expired.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new jsonMock.TokenExpiredError('jwt expired', new Date());
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_TOKEN_INVALID'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GUEST_SESSION_NOT_FOUND — session không tồn tại trong DB
  // -------------------------------------------------------------------------
  describe('session not found in DB', () => {
    it('trả về 401 GUEST_SESSION_NOT_FOUND khi session không tồn tại', async () => {
      const validToken = 'valid.token.here';
      mockRequest.headers = { authorization: `Bearer ${validToken}` };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_NOT_FOUND'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GUEST_SESSION_EXPIRED — session không ACTIVE
  // -------------------------------------------------------------------------
  describe('session not ACTIVE', () => {
    it('trả về 401 GUEST_SESSION_EXPIRED khi session status = EXPIRED', async () => {
      mockRequest.headers = { authorization: 'Bearer valid.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() + 86400000)
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_EXPIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('trả về 401 GUEST_SESSION_EXPIRED khi session status = CLAIMED', async () => {
      mockRequest.headers = { authorization: 'Bearer valid.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'CLAIMED',
        expiresAt: new Date(Date.now() + 86400000)
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_EXPIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('trả về 401 GUEST_SESSION_EXPIRED khi session status = PURGED', async () => {
      mockRequest.headers = { authorization: 'Bearer valid.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'PURGED',
        expiresAt: new Date(Date.now() + 86400000)
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_EXPIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GUEST_SESSION_EXPIRED — session đã hết hạn theo expiresAt
  // -------------------------------------------------------------------------
  describe('session expired by expiresAt', () => {
    it('trả về 401 GUEST_SESSION_EXPIRED khi expiresAt đã qua', async () => {
      mockRequest.headers = { authorization: 'Bearer valid.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1000) // đã hết hạn 1 giây trước
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_EXPIRED'
        })
      );
      expect(nextFunction).not.toHaveBeenCalled();

      // Verify auto-expire được gọi để sync DB state
      await new Promise(resolve => setImmediate(resolve));
      expect(guestWalletSessionRepository.updateGuestWalletSession).toHaveBeenCalledWith(
        'session-123',
        { status: 'EXPIRED' }
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — valid token, active session, chưa hết hạn
  // -------------------------------------------------------------------------
  describe('valid session — pass through', () => {
    it('gọi next() và attach guestSession khi token và session hợp lệ', async () => {
      const expiresAt = new Date(Date.now() + 86400000);
      mockRequest.headers = { authorization: 'Bearer valid.token' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'ACTIVE',
        expiresAt
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect((mockRequest as GuestSessionRequest).guestSession).toEqual({
        sessionId: 'session-123',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'ACTIVE',
        expiresAt
      });
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('whitespace trong token được trim đúng cách', async () => {
      const expiresAt = new Date(Date.now() + 86400000);
      mockRequest.headers = { authorization: 'Bearer   valid.token.here   ' };
      (guestJsonWebToken.verifyGuestSessionToken as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'session-456',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a'
      });
      (guestWalletSessionRepository.findGuestWalletSessionById as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 'session-456',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f5C21a',
        status: 'ACTIVE',
        expiresAt
      });

      const middleware = createGuestAuthMiddleware();
      await middleware(
        mockRequest as GuestSessionRequest,
        mockResponse as Response,
        nextFunction
      );

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });
  });
});
