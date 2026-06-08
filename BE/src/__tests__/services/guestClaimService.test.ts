/**
 * Unit tests cho guestClaimService.ts — Keyless Claim flow business logic.
 * Bao gồm: prepareClaimEOA, executeKeylessClaim, handlePartialClaim,
 * và các utility functions (encryption, calldata decoding).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

// =============================================================================
// HELPER FUNCTIONS - Outside mock scope to use real ethers
// =============================================================================

/**
 * Creates a valid Kernel.changeOwner calldata using real ethers
 */
function createValidChangeOwnerCalldata(targetAddress: string): string {
  const iface = new ethers.Interface(['function changeOwner(address newOwner)']);
  return iface.encodeFunctionData('changeOwner', [targetAddress]);
}

/**
 * Creates an invalid transfer calldata using real ethers
 */
function createInvalidTransferCalldata(): string {
  const iface = new ethers.Interface(['function transfer(address recipient)']);
  return iface.encodeFunctionData('transfer', ['0x0000000000000000000000000000000000000001']);
}

/**
 * Creates a changeOwner calldata with wrong target address using real ethers
 */
function createWrongTargetCalldata(wrongAddress: string): string {
  const iface = new ethers.Interface(['function changeOwner(address newOwner)']);
  return iface.encodeFunctionData('changeOwner', [wrongAddress]);
}

// =============================================================================
// MOCK ethers - Only mock Wallet.createRandom
// =============================================================================
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Wallet: {
      createRandom: vi.fn(() => ({
        privateKey: '0xabc123def456789012345678901234567890abcd',
        address: '0xABC123DEF456789012345678901234567890ABCD',
      })),
    },
  };
});

// =============================================================================
// CONFIGURE OTHER MOCKS
// =============================================================================

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../utils/applicationError', () => ({
  ApplicationError: class ApplicationError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: string;

    constructor(message: string, statusCode: number, errorCode: string) {
      super(message);
      this.name = 'ApplicationError';
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  },
}));

vi.mock('mongoose', () => {
  const mockClientSession = {
    withTransaction: vi.fn(async (cb: () => Promise<void>) => {
      await cb();
    }),
    endSession: vi.fn(),
  };
  return {
    default: {
      startSession: vi.fn(() => Promise.resolve(mockClientSession)),
    },
    ClientSession: {},
  };
});

/**
 * Mock GuestClaimEoaModel — có findOne để test validate logic,
 * create để test encrypt flow, findOneAndUpdate để test mark-as-used.
 */
vi.mock('../../models/guestClaimEoaModel', () => ({
  GuestClaimEoaModel: {
    findOne: vi.fn(() => ({
      lean: vi.fn(() => ({
        exec: vi.fn(),
      })),
    })) as any,
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../models/walletClaimHistoryModel', () => ({
  WalletClaimHistoryModel: {
    create: vi.fn(),
  },
}));

/**
 * Mock repository — bao gồm cả mock for GuestWalletSessionModel để tránh undefined.
 * findGuestWalletSessionById là function được export từ repository.
 * GuestWalletSessionModel được import bên trong repository và cần được mock.
 */
vi.mock('../../models/guestWalletSessionModel', () => ({
  GuestWalletSessionModel: {
    findOne: vi.fn(() => ({
      lean: vi.fn(() => ({
        exec: vi.fn(),
      })),
    })) as any,
  },
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionById: vi.fn(),
  markGuestSessionAsClaimed: vi.fn(),
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  linkAuditsToClaimedUser: vi.fn(),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import {
  prepareClaimEOA,
  executeKeylessClaim,
  handlePartialClaim,
  encryptClaimEoaPrivateKey,
  reEncryptClaimEoaPrivateKey,
} from '../../services/guestClaimService';
import { ApplicationError } from '../../utils/applicationError';
import { GuestClaimEoaModel } from '../../models/guestClaimEoaModel';
import { WalletClaimHistoryModel } from '../../models/walletClaimHistoryModel';
import { findGuestWalletSessionById, markGuestSessionAsClaimed } from '../../repositories/guestWalletSessionRepository';
import { linkAuditsToClaimedUser } from '../../repositories/anonymousDonationAuditRepository';
import mongoose from 'mongoose';
import type { GuestWalletSession } from '../../models/guestWalletSessionModel';

// =============================================================================
// FIXTURES
// =============================================================================

const FIXTURE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const FIXTURE_USER_ID = 'user-123';
const FIXTURE_GUEST_WALLET = '0xabc123def456789012345678901234567890abcd';
const FIXTURE_IP = '192.168.1.1';
const FIXTURE_USER_AGENT = 'Mozilla/5.0 Test Browser';
const FIXTURE_FINGERPRINT = 'a'.repeat(64);
const FIXTURE_SERVER_SECRET = 'a'.repeat(32);
const FIXTURE_MASTER_KEY = 'b'.repeat(32);

function createMockActiveSession(overrides: Partial<GuestWalletSession> = {}): GuestWalletSession {
  const now = Date.now();
  return {
    sessionId: FIXTURE_SESSION_ID,
    walletAddress: FIXTURE_GUEST_WALLET.toLowerCase(),
    deviceFingerprintHash: FIXTURE_FINGERPRINT,
    ipAddress: FIXTURE_IP,
    userAgent: FIXTURE_USER_AGENT,
    status: 'ACTIVE',
    donationCount: 0,
    totalDonatedAmount: 0,
    totalSponsoredGas: 0,
    renewalCount: 0,
    claimedByUserId: null,
    serverSalt: 'test-salt',
    smartAccountOwnerEncryptedPrivateKey: null,
    hasPendingDonation: false,
    pendingAlertSentAt: null,
    expiresAt: new Date(now + 3600 * 1000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

function createMockClaimRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: FIXTURE_SESSION_ID,
    claimNonce: 'claim-nonce-uuid',
    claimEoaAddress: '0xabc123def456789012345678901234567890abcd',
    claimedByUserId: FIXTURE_USER_ID,
    encryptedPrivateKey: 'encrypted-key-data',
    iv: 'iv-hex-24chars',
    authTag: 'auth-tag-hex-32chars',
    expiresAt: new Date(Date.now() + 3600 * 1000),
    usedAt: null,
    ...overrides,
  };
}

function createFindOneMock<T>(result: T | null) {
  return vi.fn((): any => ({
    lean: vi.fn((): any => ({
      exec: vi.fn((): any => Promise.resolve(result)),
    })),
  }));
}

// =============================================================================
// PREPARE CLAIM EOA TESTS
// =============================================================================

describe('prepareClaimEOA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAIM_EOA_ENCRYPTION_SECRET = FIXTURE_SERVER_SECRET;
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);
    vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(null));
    vi.mocked(GuestClaimEoaModel.create).mockResolvedValue({} as any);
  });

  describe('Session validation errors', () => {
    it('should throw GUEST_SESSION_NOT_FOUND when session does not exist', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      try {
        await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_NOT_FOUND');
        expect((error as ApplicationError).statusCode).toBe(404);
      }
    });

    it('should throw GUEST_WALLET_MISMATCH when wallet address does not match', async () => {
      const session = createMockActiveSession({
        walletAddress: '0xdifferentwallet1234567890123456789012345678abcd',
      });
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      try {
        await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_WALLET_MISMATCH');
        expect((error as ApplicationError).statusCode).toBe(403);
      }
    });

    it('should throw GUEST_SESSION_NOT_ACTIVE when session status is not ACTIVE', async () => {
      const session = createMockActiveSession({ status: 'CLAIMED' });
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      try {
        await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_NOT_ACTIVE');
        expect((error as ApplicationError).statusCode).toBe(403);
      }
    });

    it('should throw GUEST_SESSION_EXPIRED when session has expired', async () => {
      const session = createMockActiveSession({
        expiresAt: new Date(Date.now() - 1000),
      });
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      try {
        await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_EXPIRED');
        expect((error as ApplicationError).statusCode).toBe(401);
      }
    });
  });

  describe('Idempotency handling', () => {
    it('should return idempotent response when existing unused claim exists', async () => {
      const session = createMockActiveSession();
      const existingClaim = createMockClaimRecord({
        claimEoaAddress: '0xabc123def456789012345678901234567890abcd',
        claimNonce: 'existing-nonce',
        expiresAt: new Date(Date.now() + 3600 * 1000),
        usedAt: null,
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(existingClaim));

      const result = await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(result.claimEOAAddress).toBe(existingClaim.claimEoaAddress);
      expect(result.claimNonce).toBe(existingClaim.claimNonce);
      expect(GuestClaimEoaModel.create).not.toHaveBeenCalled();
    });

    it('should throw GUEST_CLAIM_ALREADY_USED when claim already used', async () => {
      const session = createMockActiveSession();
      const usedClaim = createMockClaimRecord({
        usedAt: new Date(),
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(usedClaim));

      try {
        await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_CLAIM_ALREADY_USED');
        expect((error as ApplicationError).statusCode).toBe(409);
      }
    });
  });

  describe('Successful claim preparation', () => {
    it('should successfully create new claim EOA and return address/nonce/expiresAt', async () => {
      const session = createMockActiveSession();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      const result = await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(result.claimEOAAddress).toBeDefined();
      expect(result.claimNonce).toBeDefined();
      expect(result.expiresAt).toBeDefined();
      expect(result.claimNonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should store encrypted private key in DB (not plaintext)', async () => {
      const session = createMockActiveSession();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(GuestClaimEoaModel.create).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(GuestClaimEoaModel.create).mock.calls[0][0] as Record<string, string>;
      expect(createCall.encryptedPrivateKey).toBeDefined();
      expect(createCall.encryptedPrivateKey).not.toBe('0xabc123def456');
      expect(createCall.encryptedPrivateKey!.length).toBeGreaterThan(32);
    });

    it('should use independent UUID as claimNonce (not sessionId)', async () => {
      const session = createMockActiveSession();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      await prepareClaimEOA(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      const createCall = vi.mocked(GuestClaimEoaModel.create).mock.calls[0][0] as Record<string, string>;
      expect(createCall.claimNonce).not.toBe(FIXTURE_SESSION_ID);
      expect(createCall.claimNonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(createCall.sessionId).toBe(FIXTURE_SESSION_ID);
    });
  });
});

// =============================================================================
// EXECUTE KEYLESS CLAIM TESTS
// =============================================================================

describe('executeKeylessClaim', () => {
  const validUserOp = {
    sender: '0xSenderAddress123456789012345678901234567890AB',
    nonce: '0',
    initCode: '0x',
    callData: '0x',
    callGasLimit: '21000',
    verificationGasLimit: '100000',
    preVerificationGas: '21000',
    maxFeePerGas: '150000000',
    maxPriorityFeePerGas: '150000000',
    paymasterAndData: '0x',
    signature: '0x',
  };

  const createValidRequest = (overrides: Record<string, unknown> = {}) => ({
    sessionId: FIXTURE_SESSION_ID,
    guestWalletAddress: FIXTURE_GUEST_WALLET,
    claimNonce: 'claim-nonce-uuid',
    claimedByUserId: FIXTURE_USER_ID,
    signedUserOp: validUserOp,
    isNewAccount: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAIM_EOA_ENCRYPTION_SECRET = FIXTURE_SERVER_SECRET;
    process.env.CLAIM_EOA_MASTER_KEY = FIXTURE_MASTER_KEY;
    process.env.ZERODEV_BUNDLER_URL = 'https://bundler.example.com';
    process.env.ZERODEV_ENTRY_POINT_ADDRESS = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
  });

  describe('Session and claim validation errors', () => {
    it('should throw GUEST_SESSION_NOT_FOUND when session does not exist', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      try {
        await executeKeylessClaim(createValidRequest(), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_NOT_FOUND');
      }
    });

    it('should throw GUEST_CLAIM_NONCE_INVALID when claim record does not exist', async () => {
      const session = createMockActiveSession();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(null));

      try {
        await executeKeylessClaim(createValidRequest(), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_CLAIM_NONCE_INVALID');
      }
    });

    it('should throw CLAIM_SESSION_MISMATCH when claimRecord.sessionId does not match request.sessionId', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord({
        sessionId: 'different-session-id',
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      try {
        await executeKeylessClaim(createValidRequest(), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('CLAIM_SESSION_MISMATCH');
      }
    });

    it('should throw GUEST_CLAIM_ALREADY_USED when claim already used', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord({
        usedAt: new Date(),
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      try {
        await executeKeylessClaim(createValidRequest(), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_CLAIM_ALREADY_USED');
      }
    });

    it('should throw GUEST_CLAIM_NONCE_EXPIRED when TTL expired', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord({
        expiresAt: new Date(Date.now() - 1000),
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      try {
        await executeKeylessClaim(createValidRequest(), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_CLAIM_NONCE_EXPIRED');
      }
    });

    it('should throw FORBIDDEN when claimedByUserId does not match', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord({
        claimedByUserId: 'different-user-id',
      });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      try {
        await executeKeylessClaim(createValidRequest({ claimedByUserId: FIXTURE_USER_ID }), FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('FORBIDDEN');
      }
    });
  });

  describe('Calldata validation', () => {
    it('should throw INVALID_CALLDATA when calldata is not Kernel.changeOwner', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord();

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      const wrongCallData = createInvalidTransferCalldata();

      try {
        await executeKeylessClaim(
          createValidRequest({
            signedUserOp: { ...validUserOp, callData: wrongCallData as `0x${string}` },
          }),
          FIXTURE_IP,
          FIXTURE_USER_AGENT
        );
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('INVALID_CALLDATA');
      }
    });

    it('should throw INVALID_CALLDATA when calldata targets wrong address', async () => {
      const session = createMockActiveSession();
      const claimRecord = createMockClaimRecord();

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(claimRecord));

      const wrongTarget = '0x0000000000000000000000000000000000000001';
      const wrongCallData = createWrongTargetCalldata(wrongTarget);

      try {
        await executeKeylessClaim(
          createValidRequest({
            signedUserOp: { ...validUserOp, callData: wrongCallData as `0x${string}` },
          }),
          FIXTURE_IP,
          FIXTURE_USER_AGENT
        );
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('INVALID_CALLDATA');
      }
    });
  });

  describe('Bundler submission - HTTP error handling', () => {
    const mockSession = createMockActiveSession();
    const mockClaimRecord = createMockClaimRecord();
    const originalSetTimeout = global.setTimeout;

    beforeEach(() => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockSession);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(mockClaimRecord));
      // Mock setTimeout để tránh đợi exponential backoff retry trong test (1s+2s+4s)
      vi.stubGlobal('setTimeout', vi.fn((cb: () => void) => { cb(); return 0; }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      global.setTimeout = originalSetTimeout;
    });

    it('should throw BUNDLER_HTTP_CLIENT_ERROR for HTTP 400', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        text: vi.fn(() => Promise.resolve('Bad request')),
      };
      global.fetch = vi.fn(() => Promise.resolve(mockResponse as unknown as Response));

      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      try {
        await executeKeylessClaim(
          createValidRequest({
            signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
          }),
          FIXTURE_IP,
          FIXTURE_USER_AGENT
        );
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('BUNDLER_HTTP_CLIENT_ERROR');
        expect((error as ApplicationError).statusCode).toBe(502);
      }
    });

    it('should throw BUNDLER_HTTP_ERROR for HTTP 500', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn(() => Promise.resolve('Internal server error')),
      };
      global.fetch = vi.fn(() => Promise.resolve(mockResponse as unknown as Response));

      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      try {
        await executeKeylessClaim(
          createValidRequest({
            signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
          }),
          FIXTURE_IP,
          FIXTURE_USER_AGENT
        );
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('BUNDLER_HTTP_ERROR');
      }
    });

    it('should retry on HTTP 500 up to 3 times', async () => {
      let callCount = 0;
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn(() => Promise.resolve('Server error')),
      };
      global.fetch = vi.fn(() => {
        callCount++;
        return Promise.resolve(mockResponse as unknown as Response);
      });

      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      try {
        await executeKeylessClaim(
          createValidRequest({
            signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
          }),
          FIXTURE_IP,
          FIXTURE_USER_AGENT
        );
      } catch (_error) {
        // Expected to throw after retries
      }

      expect(callCount).toBe(3);
    });
  });

  describe('Database operations in transaction', () => {
    const mockSession = createMockActiveSession();
    const mockClaimRecord = createMockClaimRecord();
    const mockMongoSession = {
      withTransaction: vi.fn(async (cb: () => Promise<void>) => {
        await cb();
      }),
      endSession: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockSession);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(mockClaimRecord));
      vi.mocked(markGuestSessionAsClaimed).mockResolvedValue({} as any);
      vi.mocked(linkAuditsToClaimedUser).mockResolvedValue(5);
      vi.mocked(GuestClaimEoaModel.findOneAndUpdate).mockResolvedValue({} as any);
      vi.mocked(WalletClaimHistoryModel.create).mockResolvedValue([] as any);
      vi.mocked(mongoose.startSession).mockResolvedValue(mockMongoSession as unknown as mongoose.ClientSession);

      const mockJson = vi.fn(() => Promise.resolve({ result: '0x' + 'a'.repeat(64) }));
      const mockResponse = {
        ok: true,
        json: mockJson,
      };
      global.fetch = vi.fn(() => Promise.resolve(mockResponse as unknown as Response));
    });

    it('should update session to CLAIMED, link audits, mark claim as used, create history record', async () => {
      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      await executeKeylessClaim(
        createValidRequest({
          signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
        }),
        FIXTURE_IP,
        FIXTURE_USER_AGENT
      );

      expect(markGuestSessionAsClaimed).toHaveBeenCalledWith(
        FIXTURE_SESSION_ID,
        FIXTURE_USER_ID,
        mockMongoSession
      );
      expect(linkAuditsToClaimedUser).toHaveBeenCalledWith(
        FIXTURE_SESSION_ID,
        FIXTURE_USER_ID,
        mockMongoSession
      );
      expect(GuestClaimEoaModel.findOneAndUpdate).toHaveBeenCalled();
      expect(WalletClaimHistoryModel.create).toHaveBeenCalled();
    });

    it('should wrap all DB writes in transaction', async () => {
      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      await executeKeylessClaim(
        createValidRequest({
          signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
        }),
        FIXTURE_IP,
        FIXTURE_USER_AGENT
      );

      expect(mockMongoSession.withTransaction).toHaveBeenCalledTimes(1);
      expect(mockMongoSession.endSession).toHaveBeenCalledTimes(1);
    });

    it('should return correct donationsMerged count from linkAuditsToClaimedUser', async () => {
      vi.mocked(linkAuditsToClaimedUser).mockResolvedValue(10);

      const correctCallData = createValidChangeOwnerCalldata(mockClaimRecord.claimEoaAddress);

      const result = await executeKeylessClaim(
        createValidRequest({
          signedUserOp: { ...validUserOp, callData: correctCallData as `0x${string}` },
        }),
        FIXTURE_IP,
        FIXTURE_USER_AGENT
      );

      expect(result.donationsMerged).toBe(10);
    });
  });
});

// =============================================================================
// HANDLE PARTIAL CLAIM TESTS
// =============================================================================

describe('handlePartialClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);
    vi.mocked(markGuestSessionAsClaimed).mockResolvedValue({} as any);
    vi.mocked(linkAuditsToClaimedUser).mockResolvedValue(0);
    vi.mocked(WalletClaimHistoryModel.create).mockResolvedValue([] as any);
    vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(null));
  });

  describe('Session validation errors', () => {
    it('should throw GUEST_SESSION_NOT_FOUND when session does not exist', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      try {
        await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_NOT_FOUND');
      }
    });

    it('should throw GUEST_WALLET_MISMATCH when wallet mismatch', async () => {
      const session = createMockActiveSession({
        walletAddress: '0xdifferentwallet1234567890123456789012345678abcd',
      });
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      try {
        await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_WALLET_MISMATCH');
      }
    });

    it('should throw GUEST_SESSION_NOT_ACTIVE when status is not ACTIVE', async () => {
      const session = createMockActiveSession({ status: 'CLAIMED' });
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);

      try {
        await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_SESSION_NOT_ACTIVE');
      }
    });

    it('should throw GUEST_CLAIM_ALREADY_PREPARED when active EOA claim exists', async () => {
      const session = createMockActiveSession();
      const existingEoaClaim = createMockClaimRecord({ usedAt: null });

      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(GuestClaimEoaModel.findOne).mockImplementation(createFindOneMock(existingEoaClaim));

      try {
        await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);
        expect.fail('Should have thrown ApplicationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).errorCode).toBe('GUEST_CLAIM_ALREADY_PREPARED');
      }
    });
  });

  describe('Successful partial claim', () => {
    const mockMongoSession = {
      withTransaction: vi.fn(async (cb: () => Promise<void>) => {
        await cb();
      }),
      endSession: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      const session = createMockActiveSession();
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(session);
      vi.mocked(markGuestSessionAsClaimed).mockResolvedValue({} as any);
      vi.mocked(linkAuditsToClaimedUser).mockResolvedValue(3);
      vi.mocked(WalletClaimHistoryModel.create).mockResolvedValue([] as any);
      vi.mocked(mongoose.startSession).mockResolvedValue(mockMongoSession as unknown as mongoose.ClientSession);
    });

    it('should successfully create partial claim without ownership migration', async () => {
      const result = await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(result.claimId).toBeDefined();
      expect(result.claimType).toBe('PARTIAL_CLAIM');
      expect(result.changeOwnerTxHash).toBe('');
      expect(result.encryptedPrivateKey).toBeUndefined();
    });

    it('should set keyMigrated = false in history record', async () => {
      await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(WalletClaimHistoryModel.create).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(WalletClaimHistoryModel.create).mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(createCall[0].keyMigrated).toBe(false);
      expect(createCall[0].claimType).toBe('PARTIAL_CLAIM');
    });

    it('should wrap DB writes in transaction', async () => {
      await handlePartialClaim(FIXTURE_SESSION_ID, FIXTURE_GUEST_WALLET, FIXTURE_USER_ID, FIXTURE_IP, FIXTURE_USER_AGENT);

      expect(mockMongoSession.withTransaction).toHaveBeenCalledTimes(1);
      expect(mockMongoSession.endSession).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// UTILITY FUNCTION TESTS
// =============================================================================

describe('Utility functions', () => {
  beforeEach(() => {
    process.env.CLAIM_EOA_ENCRYPTION_SECRET = FIXTURE_SERVER_SECRET;
    process.env.CLAIM_EOA_MASTER_KEY = FIXTURE_MASTER_KEY;
  });

  describe('encryptClaimEoaPrivateKey', () => {
    it('should produce different ciphertext each call (random salt)', () => {
      const privateKey = '0xabc123def456789012345678901234567890abcd';

      const result1 = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);
      const result2 = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);

      expect(result1.encryptedPrivateKey).not.toBe(result2.encryptedPrivateKey);
      expect(result1.iv).not.toBe(result2.iv);
      expect(result1.authTag).not.toBe(result2.authTag);
    });

    it('should output be self-contained with salt prepended', () => {
      const privateKey = '0xabc123def456789012345678901234567890abcd';

      const result = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);

      const salt = result.encryptedPrivateKey.slice(0, 32);
      expect(result.encryptedPrivateKey.startsWith(salt)).toBe(true);
      expect(salt).toMatch(/^[a-f0-9]{32}$/);
    });

    it('should return hex strings for iv and authTag', () => {
      const privateKey = '0xabc123def456789012345678901234567890abcd';

      const result = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);

      expect(result.iv).toMatch(/^[a-f0-9]+$/);
      expect(result.authTag).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('reEncryptClaimEoaPrivateKey', () => {
    it('should output be different from input ciphertext', () => {
      const privateKey = '0xabc123def456789012345678901234567890abcd';
      const layer1 = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);

      const layer2 = reEncryptClaimEoaPrivateKey(layer1.encryptedPrivateKey, FIXTURE_MASTER_KEY);

      expect(layer2.encryptedPrivateKey).not.toBe(layer1.encryptedPrivateKey);
      expect(layer2.iv).not.toBe(layer1.iv);
      expect(layer2.authTag).not.toBe(layer1.authTag);
    });

    it('should produce different ciphertext each call (random salt)', () => {
      const privateKey = '0xabc123def456789012345678901234567890abcd';
      const layer1 = encryptClaimEoaPrivateKey(privateKey, FIXTURE_SERVER_SECRET);

      const layer2a = reEncryptClaimEoaPrivateKey(layer1.encryptedPrivateKey, FIXTURE_MASTER_KEY);
      const layer2b = reEncryptClaimEoaPrivateKey(layer1.encryptedPrivateKey, FIXTURE_MASTER_KEY);

      expect(layer2a.encryptedPrivateKey).not.toBe(layer2b.encryptedPrivateKey);
    });
  });
});
