import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  createGuestLayer1RateLimitMiddleware,
  createGuestSessionRateLimitMiddleware,
  createGuestDonationRateLimitMiddleware,
  stopCleanupScheduler
} from '../../middleware/guestRateLimitMiddleware';
import { GuestSessionRequest } from '../../middleware/guestAuthMiddleware';

const mockRedisClient = {
  multi: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  zRem: vi.fn(),
  zRemRangeByScore: vi.fn(),
  zCard: vi.fn(),
  zAdd: vi.fn(),
  isOpen: true
};

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

function createMockRequest(overrides: Partial<Request> = {}): Partial<GuestSessionRequest> {
  return {
    ip: '192.168.1.100',
    headers: {},
    path: '/api/guest/session',
    ...overrides
  } as Partial<GuestSessionRequest>;
}

function createMockResponse(): Partial<Response> {
  return {
    status: vi.fn().mockReturnThis() as Response['status'],
    json: vi.fn().mockReturnThis() as Response['json']
  };
}

describe('guestRateLimitMiddleware', () => {
  let nextFunction: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    nextFunction = vi.fn();
  });

  afterEach(() => {
    stopCleanupScheduler();
  });

  // -------------------------------------------------------------------------
  // Lớp 1 — In-Memory Anti-DDoS
  // -------------------------------------------------------------------------
  describe('Lớp 1 — createGuestLayer1RateLimitMiddleware', () => {
    it('cho phép request đầu tiên từ IP mới', () => {
      const middleware = createGuestLayer1RateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      middleware(req as Request, res as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('cho phép request khi còn tokens', () => {
      const middleware = createGuestLayer1RateLimitMiddleware();
      for (let i = 0; i < 19; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        nextFunction = vi.fn();
        middleware(req as Request, res as Response, nextFunction);
        expect(nextFunction).toHaveBeenCalledTimes(1);
      }
    });

    it('reject request thứ 21+ từ cùng IP trong 10 giây', () => {
      const middleware = createGuestLayer1RateLimitMiddleware();
      for (let i = 0; i < 20; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        nextFunction = vi.fn();
        middleware(req as Request, res as Response, nextFunction);
      }
      const req = createMockRequest();
      const res = createMockResponse();
      nextFunction = vi.fn();
      middleware(req as Request, res as Response, nextFunction);
      expect(nextFunction).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'GUEST_RATE_LIMIT_EXCEEDED'
        })
      );
    });

    it('dùng fallback "unknown" khi request.ip không có', () => {
      const middleware = createGuestLayer1RateLimitMiddleware();
      const req = createMockRequest({ ip: undefined });
      const res = createMockResponse();
      middleware(req as Request, res as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Lớp 2 — Redis session rate limit
  // -------------------------------------------------------------------------
  describe('Lớp 2 — createGuestSessionRateLimitMiddleware', () => {
    it('gọi next khi Redis chưa sẵn sàng (graceful fallback)', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const middleware = createGuestSessionRateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('gọi next khi request nằm trong giới hạn quota', async () => {
      const mockPipeline = {
        zRemRangeByScore: vi.fn().mockReturnThis(),
        zCard: vi.fn().mockReturnThis(),
        zAdd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([0, 2, 1, true])
      };
      mockRedisClient.multi.mockReturnValue(mockPipeline);

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestSessionRateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('trả 429 khi vượt quota 5 sessions/IP/hour', async () => {
      const mockPipeline = {
        zRemRangeByScore: vi.fn().mockReturnThis(),
        zCard: vi.fn().mockReturnThis(),
        zAdd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([0, 5, 1, true])
      };
      mockRedisClient.multi.mockReturnValue(mockPipeline);
      mockRedisClient.zRem = vi.fn();

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestSessionRateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_RATE_LIMIT_EXCEEDED'
        })
      );
    });

    it('rollback bằng zRem(member) chính xác khi vượt quota', async () => {
      const mockPipeline = {
        zRemRangeByScore: vi.fn().mockReturnThis(),
        zCard: vi.fn().mockReturnThis(),
        zAdd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([0, 5, 1, true])
      };
      mockRedisClient.multi.mockReturnValue(mockPipeline);
      mockRedisClient.zRem = vi.fn();

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestSessionRateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      // zRem(member) được gọi với đúng key và member value (không phải zRemRangeByScore)
      expect(mockRedisClient.zRem).toHaveBeenCalledTimes(1);
      const [key, member] = (mockRedisClient.zRem as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(key).toBe('guest:rate:session:192.168.1.100');
      expect(member).toMatch(/^\d+-\d+-[a-z0-9-]+$/);
    });

    it('cho phép request khi Redis pipeline throw (fail open)', async () => {
      const mockPipeline = {
        zRemRangeByScore: vi.fn().mockReturnThis(),
        zCard: vi.fn().mockReturnThis(),
        zAdd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('Redis timeout'))
      };
      mockRedisClient.multi.mockReturnValue(mockPipeline);

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestSessionRateLimitMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Lớp 2 — Redis donation rate limit
  // -------------------------------------------------------------------------
  describe('Lớp 2 — createGuestDonationRateLimitMiddleware', () => {
    it('trả 401 khi không có guestSession trong request', async () => {
      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest() as Partial<GuestSessionRequest>;
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_SESSION_REQUIRED'
        })
      );
    });

    it('cho phép request khi Redis chưa sẵn sàng (graceful fallback)', async () => {
      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest({ guestSession: { sessionId: 'session-123' } } as Partial<GuestSessionRequest>);
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });

    it('cho phép request khi count <= 3', async () => {
      mockRedisClient.multi.mockReturnValue({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([2])
      });

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest({ guestSession: { sessionId: 'session-123' } } as Partial<GuestSessionRequest>);
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('trả 429 khi count > 3', async () => {
      mockRedisClient.multi.mockReturnValue({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([5])
      });

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest({ guestSession: { sessionId: 'session-123' } } as Partial<GuestSessionRequest>);
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'GUEST_DONATION_RATE_LIMIT_EXCEEDED'
        })
      );
    });

    it('set expire khi đây là request đầu tiên (count === 1)', async () => {
      const execMock = vi.fn().mockResolvedValue([1]);
      mockRedisClient.multi.mockReturnValue({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: execMock
      });

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest({ guestSession: { sessionId: 'session-123' } } as Partial<GuestSessionRequest>);
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(execMock).toHaveBeenCalled();
      expect(nextFunction).toHaveBeenCalledTimes(1);
    });

    it('cho phép request khi Redis incr throw (fail open)', async () => {
      mockRedisClient.multi.mockReturnValue({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('Redis connection error'))
      });

      const { getRedisClientIfReady } = await import('../../config/redis');
      (getRedisClientIfReady as ReturnType<typeof vi.fn>).mockReturnValue(mockRedisClient);

      const middleware = createGuestDonationRateLimitMiddleware();
      const req = createMockRequest({ guestSession: { sessionId: 'session-123' } } as Partial<GuestSessionRequest>);
      const res = createMockResponse();
      await middleware(req as Request, res as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });
  });
});
