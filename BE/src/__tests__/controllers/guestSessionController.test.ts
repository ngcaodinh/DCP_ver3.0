import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

/**
 * Mock config/logger
 */
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

/**
 * Mock services
 */
vi.mock('../../services/guestSessionService', () => ({
  createNewGuestSession: vi.fn(),
  refreshExistingSession: vi.fn(),
  getSessionStatus: vi.fn()
}));

/**
 * Mock ApplicationError để controller có thể dùng instanceof check.
 * Dùng vi.hoisted để class được define trước vi.mock() hoisting.
 */
const { ApplicationError } = vi.hoisted(() => {
  class ApplicationError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: string;

    constructor(message: string, statusCode: number, errorCode: string) {
      super(message);
      this.name = 'ApplicationError';
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return { ApplicationError };
});

vi.mock('../../utils/applicationError', () => ({
  ApplicationError
}));

import {
  handleCreateGuestSession,
  handleRefreshGuestSession,
  handleGetGuestSessionStatus,
  handleSponsorGuestPaymaster
} from '../../controllers/guestSessionController';
import { createNewGuestSession, refreshExistingSession, getSessionStatus } from '../../services/guestSessionService';

/**
 * Tạo mock Request với overrides cho trước.
 */
function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    body: {},
    headers: { 'user-agent': 'TestBrowser/1.0' },
    ip: '127.0.0.1',
    ...overrides
  } as unknown as Request;
}

/**
 * Tạo mock Response object với chainable methods.
 */
function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response;
}

/** Fingerprint hash hợp lệ: 64 ký tự hex (SHA-256 output). */
const validFingerprintHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
/** Wallet address hợp lệ (EIP-55 checksum). */
const validWalletAddress = '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a';

describe('handleCreateGuestSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tạo session thành công khi wallet address và fingerprint hash hợp lệ', async () => {
    (createNewGuestSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: 'new-session-id',
      guestSessionToken: 'eyJhbGciOiJIUzI1NiJ9.mock',
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      serverSalt: 'abc123',
      donationQuota: 3
    });

    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(createNewGuestSession).toHaveBeenCalledWith(
      validWalletAddress,
      validFingerprintHash,
      '127.0.0.1',
      'TestBrowser/1.0',
      undefined
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('chấp nhận lowercase wallet address (ethers.getAddress() normalize checksum)', async () => {
    // ethers.getAddress() chấp nhận cả checksum và non-checksum addresses
    // nên lowercase address không còn bị reject — đây là behavior đúng
    (createNewGuestSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: 'new-session-id',
      guestSessionToken: 'eyJhbGciOiJIUzI1NiJ9.mock',
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      serverSalt: 'abc123',
      donationQuota: 3
    });

    const req = createMockRequest({
      body: {
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('reject request khi wallet address có độ dài không đúng (thiếu ký tự)', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595',
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_WALLET_ADDRESS' })
    );
    expect(createNewGuestSession).not.toHaveBeenCalled();
  });

  it('reject request khi fingerprint hash ít hơn 64 ký tự', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: 'fp-hash-abc123'
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_FINGERPRINT' })
    );
    expect(createNewGuestSession).not.toHaveBeenCalled();
  });

  it('reject request khi fingerprint hash chứa ký tự không phải hex', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_FINGERPRINT' })
    );
    expect(createNewGuestSession).not.toHaveBeenCalled();
  });

  it('reject request khi fingerprint hash dài hơn 64 ký tự', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: 'aabbccdd001122334455667788990011223344556677889900112233445566778899aabbccdd00'
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_FINGERPRINT' })
    );
  });

  it('reject request khi thiếu walletAddress', async () => {
    const req = createMockRequest({
      body: {
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_WALLET_ADDRESS' })
    );
  });

  it('reject request khi thiếu deviceFingerprintHash', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_FINGERPRINT' })
    );
  });

  it('reject request khi invalid wallet + valid fingerprint (wallet fail first)', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: 'invalid-wallet',
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_WALLET_ADDRESS' })
    );
  });

  it('reject request khi valid wallet + invalid fingerprint hash', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: 'tooshort'
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_FINGERPRINT' })
    );
  });

  it('trả về 429 khi service ném ApplicationError', async () => {
    // Mock service throw ApplicationError — controller dùng instanceof để catch
    (createNewGuestSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApplicationError(
        'Đã đạt giới hạn tạo phiên',
        429,
        'GUEST_SESSION_LIMIT_EXCEEDED'
      )
    );

    const req = createMockRequest({
      body: {
        walletAddress: validWalletAddress,
        deviceFingerprintHash: validFingerprintHash
      }
    });
    const res = createMockResponse();

    await handleCreateGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'GUEST_SESSION_LIMIT_EXCEEDED' })
    );
  });
});

describe('handleRefreshGuestSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về 401 khi không có guestSession', async () => {
    const req = createMockRequest({ guestSession: null }) as unknown as Request;
    const res = createMockResponse();

    await handleRefreshGuestSession(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'GUEST_SESSION_REQUIRED' })
    );
  });
});

describe('handleGetGuestSessionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về 401 khi không có guestSession', async () => {
    const req = createMockRequest({ guestSession: null }) as unknown as Request;
    const res = createMockResponse();

    await handleGetGuestSessionStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'GUEST_SESSION_REQUIRED' })
    );
  });
});

describe('handleSponsorGuestPaymaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về 401 khi không có guestSession', async () => {
    const req = createMockRequest({ guestSession: null }) as unknown as Request;
    const res = createMockResponse();

    await handleSponsorGuestPaymaster(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'GUEST_SESSION_REQUIRED' })
    );
  });
});
