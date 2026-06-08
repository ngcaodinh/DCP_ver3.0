/**
 * Unit tests cho donationReconciliationWorker.
 * Test các hàm getTokenBalance, reconcileSession, Semaphore, runReconciliation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockBalanceOf } = vi.hoisted(() => ({ mockBalanceOf: vi.fn() }));
// ethers.getAddress validates EIP-55 checksum. In tests, we accept all valid
// address formats (regex-passing addresses) as valid — the worker handles the
// actual checksum validation at runtime. Mocking keccak-256 is unnecessary.
const mockGetAddress = vi.hoisted(() => {
  return vi.fn((addr: string) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('invalid address');
    return addr; // Return as-is — validates format, not checksum
  });
});

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Contract: vi.fn().mockImplementation(() => ({ balanceOf: mockBalanceOf })),
    getAddress: mockGetAddress
  }
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  findUnindexedAudits: vi.fn(),
  findAuditsBySessionId: vi.fn()
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionById: vi.fn(),
  updateGuestWalletSession: vi.fn(),
  findGuestWalletSessionsByIds: vi.fn(),
  findOrphanedActiveSessions: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock redis module — lock functions in worker call getRedisClientIfReady from here.
// Use factory functions so mocks are stable and not affected by vi.fn() binding issues.
const mockRedisSetFn = vi.hoisted(() => vi.fn());
const mockRedisGetFn = vi.hoisted(() => vi.fn());
const mockRedisDelFn = vi.hoisted(() => vi.fn());
const mockRedisClientReady = vi.hoisted(() => vi.fn());

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: mockRedisClientReady,
}));

import {
  getTokenBalance,
  reconcileSession,
  resetModuleState,
  Semaphore,
  rpcProvider,
  charityTokenAddress,
  startDonationReconciliationWorker,
  runReconciliation,
  validateWorkerEnvironment
} from '../../workers/donationReconciliationWorker';
import * as anonymousDonationAuditRepository from '../../repositories/anonymousDonationAuditRepository';
import * as guestWalletSessionRepository from '../../repositories/guestWalletSessionRepository';
import type { GuestWalletSession } from '../../models/guestWalletSessionModel';
import type { AnonymousDonationAudit } from '../../models/anonymousDonationAuditModel';

// =========================================================
// Test Helpers
// =========================================================

type MockGuestSession = {
  sessionId: string;
  walletAddress: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  donationCount: number;
  totalDonatedAmount: number;
  hasPendingDonation: boolean;
};

function makeMockSession(overrides: {
  sessionId: string;
  walletAddress: string;
  status: MockGuestSession['status'];
  donationCount?: number;
  totalDonatedAmount?: number;
  hasPendingDonation?: boolean;
}): GuestWalletSession {
  return {
    deviceFingerprintHash: '0'.repeat(64),
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    totalSponsoredGas: 0,
    renewalCount: 0,
    claimedByUserId: null,
    serverSalt: 'testsalt',
    pendingAlertSentAt: null,
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    donationCount: 0,
    totalDonatedAmount: 0,
    hasPendingDonation: false,
    ...overrides
  } as GuestWalletSession;
}

function makeMockAudit(overrides: {
  sessionId: string;
  onChainTxHash: string | null;
  paymasterSponsoredGas: boolean;
}): AnonymousDonationAudit {
  return {
    auditId: `audit-${Math.random()}`,
    sessionId: overrides.sessionId,
    walletAddress: '0x0000000000000000000000000000000000000000',
    projectId: 'proj-001',
    amount: 1000,
    trustMultiplier: 1.0,
    riskScore: 0,
    userOpHash: `uop-${Math.random()}`,
    onChainTxHash: overrides.onChainTxHash,
    onChainBlockNumber: overrides.onChainTxHash ? 1 : 0,
    paymasterSponsoredGas: overrides.paymasterSponsoredGas,
    claimedByUserId: null,
    isAnonymous: true,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    createdAt: new Date(),
    indexedAt: overrides.onChainTxHash ? new Date() : null
  } as AnonymousDonationAudit;
}

function getAuditRepo() {
  return anonymousDonationAuditRepository as unknown as {
    findUnindexedAudits: ReturnType<typeof vi.fn>;
    findAuditsBySessionId: ReturnType<typeof vi.fn>;
  };
}

function getSessionRepo() {
  return guestWalletSessionRepository as unknown as {
    findGuestWalletSessionById: ReturnType<typeof vi.fn>;
    updateGuestWalletSession: ReturnType<typeof vi.fn>;
    findGuestWalletSessionsByIds: ReturnType<typeof vi.fn>;
    findOrphanedActiveSessions: ReturnType<typeof vi.fn>;
  };
}

// =========================================================
// Module State Tests
// =========================================================

describe('donationReconciliationWorker - Module State', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  it('should have rpcProvider as null initially', () => {
    expect(rpcProvider).toBeNull();
  });

  it('should have charityTokenAddress as null initially', () => {
    expect(charityTokenAddress).toBeNull();
  });

  it('should reset module state between test runs', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    resetModuleState();
    expect(rpcProvider).toBeNull();
    expect(charityTokenAddress).toBeNull();
  });
});

// =========================================================
// getTokenBalance Tests
// =========================================================

describe('donationReconciliationWorker - getTokenBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  it('should return balance when RPC call succeeds with balance > 0', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBe(BigInt(1000000));
  });

  it('should return balance = 0 when wallet has no tokens', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(0));
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBe(BigInt(0));
  });

  it('should return null when BLOCKCHAIN_RPC_URL not configured', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', '');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBeNull();
    expect(mockBalanceOf).not.toHaveBeenCalled();
  });

  it('should return null when CHARITY_TOKEN_CONTRACT_ADDRESS not configured', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '');
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBeNull();
    expect(mockBalanceOf).not.toHaveBeenCalled();
  });

  it('should return null when RPC call throws error', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockRejectedValue(new Error('RPC connection failed'));
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBeNull();
  });

  it('should return exact bigint value from RPC call', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(123456789));
    const result = await getTokenBalance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(result).toBe(BigInt(123456789));
    expect(typeof result).toBe('bigint');
  });
});

// =========================================================
// reconcileSession Tests
// =========================================================

describe('donationReconciliationWorker - reconcileSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  // --- Session not found ---

  it('should return false when session not found', async () => {
    const result = await reconcileSession('nonexistent-session', null);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Session status tests ---

  it('should return false when session status EXPIRED', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-expired',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'EXPIRED'
    });
    const result = await reconcileSession('session-expired', mockSession);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('should return false when session status CLAIMED', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-claimed',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'CLAIMED'
    });
    const result = await reconcileSession('session-claimed', mockSession);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('should return false when session status PURGED', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-purged',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'PURGED'
    });
    const result = await reconcileSession('session-purged', mockSession);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Orphaned session (no audits) ---

  it('should return false when no audit records exist and balance === 0', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-no-audits',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE'
    });
    getAuditRepo().findAuditsBySessionId.mockResolvedValue([]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(0));
    const result = await reconcileSession('session-no-audits', mockSession);
    expect(result).toBe(false);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
  });

  it('should set flag when no audit records exist but balance > 0 (orphaned session)', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-orphaned',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    getAuditRepo().findAuditsBySessionId.mockResolvedValue([]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({
      ...mockSession,
      hasPendingDonation: true
    });
    const result = await reconcileSession('session-orphaned', mockSession);
    expect(getAuditRepo().findAuditsBySessionId).toHaveBeenCalledWith('session-orphaned');
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledWith(
      'session-orphaned',
      expect.objectContaining({ hasPendingDonation: true })
    );
    expect(result).toBe(true);
  });

  it('should NOT query DB when audits pre-fetched and empty (orphaned)', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-prefetched-empty',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(500000));
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({
      ...mockSession,
      hasPendingDonation: true
    });
    // Truyền audits rỗng đã pre-fetched → không gọi findAuditsBySessionId nữa
    const result = await reconcileSession('session-prefetched-empty', mockSession, []);
    expect(getAuditRepo().findAuditsBySessionId).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should return false for orphaned session when RPC error', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-orphan-rpc-error',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    getAuditRepo().findAuditsBySessionId.mockResolvedValue([]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockRejectedValue(new Error('RPC error'));
    const result = await reconcileSession('session-orphan-rpc-error', mockSession);
    expect(result).toBe(false);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
  });

  it('should skip RPC call when hasPendingDonation already true (avoid wasting quota)', async () => {
    // Session đã được gắn cờ pending ở vòng trước, user chưa resume.
    // Worker không nên gọi RPC check balance hay update DB lặp lại mỗi 15 phút.
    const mockSession = makeMockSession({
      sessionId: 'session-already-flagged',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: true
    });
    getAuditRepo().findAuditsBySessionId.mockResolvedValue([]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');

    const result = await reconcileSession('session-already-flagged', mockSession);

    expect(result).toBe(false);
    expect(getAuditRepo().findAuditsBySessionId).not.toHaveBeenCalled();
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
  });

  // --- Audit already indexed ---

  it('should return false when audit has onChainTxHash already (indexed)', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-indexed',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE'
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-indexed', onChainTxHash: '0xtxhash123', paymasterSponsoredGas: true })
    ];
    const result = await reconcileSession('session-indexed', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Audit paymasterSponsoredGas = false ---

  it('should return false when audit paymasterSponsoredGas = false', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-not-sponsored',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE'
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-not-sponsored', onChainTxHash: null, paymasterSponsoredGas: false })
    ];
    const result = await reconcileSession('session-not-sponsored', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Balance > 0 + unindexed audit ---

  it('should set hasPendingDonation = true when balance > 0 and unindexed audit exists', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-001',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 0,
      totalDonatedAmount: 0,
      hasPendingDonation: false
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-001', onChainTxHash: null, paymasterSponsoredGas: true })
    ];
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({
      ...mockSession,
      hasPendingDonation: true
    });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await reconcileSession('session-001', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledWith(
      'session-001',
      expect.objectContaining({ hasPendingDonation: true })
    );
    expect(result).toBe(true);
  });

  // --- Balance === 0 + unindexed audit ---

  it('should return false when balance === 0 and unindexed audit exists', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-zero-balance',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 0,
      hasPendingDonation: false
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-zero-balance', onChainTxHash: null, paymasterSponsoredGas: true })
    ];
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(0));
    const result = await reconcileSession('session-zero-balance', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Balance null (RPC error) ---

  it('should return false when balance is null (RPC error)', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-rpc-error',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 0,
      hasPendingDonation: false
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-rpc-error', onChainTxHash: null, paymasterSponsoredGas: true })
    ];
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockRejectedValue(new Error('RPC error'));
    const result = await reconcileSession('session-rpc-error', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // --- Multiple audits ---

  it('should flag session when one audit indexed, one unindexed with balance > 0', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-multi',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 0,
      hasPendingDonation: false
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-multi', onChainTxHash: '0xindexed', paymasterSponsoredGas: true }),
      makeMockAudit({ sessionId: 'session-multi', onChainTxHash: null, paymasterSponsoredGas: true })
    ];
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({
      ...mockSession,
      hasPendingDonation: true
    });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(500000));
    const result = await reconcileSession('session-multi', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledWith(
      'session-multi',
      expect.objectContaining({ hasPendingDonation: true })
    );
    expect(result).toBe(true);
  });

  it('should return false when all audits are indexed', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-all-indexed',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE'
    });
    const mockAudits = [
      makeMockAudit({ sessionId: 'session-all-indexed', onChainTxHash: '0xhash1', paymasterSponsoredGas: true }),
      makeMockAudit({ sessionId: 'session-all-indexed', onChainTxHash: '0xhash2', paymasterSponsoredGas: true })
    ];
    const result = await reconcileSession('session-all-indexed', mockSession, mockAudits);
    expect(getSessionRepo().updateGuestWalletSession).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('should return false for empty sessionId string (session not found)', async () => {
    const result = await reconcileSession('', null);
    expect(result).toBe(false);
  });
});

// =========================================================
// Semaphore Tests
// =========================================================

describe('donationReconciliationWorker - Semaphore', () => {
  it('should execute single task successfully', async () => {
    const semaphore = new Semaphore(1);
    const result = await semaphore.run(async () => 42);
    expect(result).toBe(42);
  });

  it('should allow multiple tasks to run concurrently within limit', async () => {
    const semaphore = new Semaphore(3);
    const running: number[] = [];
    const tasks = [0, 1, 2].map((i) =>
      semaphore.run(async () => {
        running.push(i);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return i;
      })
    );
    const results = await Promise.all(tasks);
    expect(results.sort()).toEqual([0, 1, 2]);
    expect(running.length).toBe(3);
  });

  it('should queue tasks when concurrency limit reached', async () => {
    const semaphore = new Semaphore(2);
    const slowTask1 = semaphore.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'task1';
    });
    const slowTask2 = semaphore.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'task2';
    });
    let task3Started = false;
    const task3Promise = semaphore.run(async () => {
      task3Started = true;
      return 'task3';
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(task3Started).toBe(false);
    await slowTask1;
    await slowTask2;
    await task3Promise;
    expect(task3Started).toBe(true);
  });

  it('should complete all tasks even when some throw errors', async () => {
    const semaphore = new Semaphore(2);
    const task1 = semaphore.run(async () => { throw new Error('Task 1 failed'); });
    const task2 = semaphore.run(async () => 'Task 2 succeeded');
    const task3 = semaphore.run(async () => 'Task 3 succeeded');
    const results = await Promise.allSettled([task1, task2, task3]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
  });

  it('should execute queued tasks in FIFO order', async () => {
    const semaphore = new Semaphore(1);
    const executionOrder: number[] = [];
    const task1 = semaphore.run(async () => { executionOrder.push(1); return 1; });
    const task2 = semaphore.run(async () => { executionOrder.push(2); return 2; });
    const task3 = semaphore.run(async () => { executionOrder.push(3); return 3; });
    await Promise.all([task1, task2, task3]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('should verify RPC concurrency limited to 10 via Semaphore', async () => {
    const semaphore = new Semaphore(10);
    const concurrentCount = { max: 0, current: 0 };
    const tasks = Array(20).fill(null).map(
      (_, i) => semaphore.run(async () => {
        concurrentCount.current++;
        concurrentCount.max = Math.max(concurrentCount.max, concurrentCount.current);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount.current--;
        return i;
      })
    );
    await Promise.all(tasks);
    expect(concurrentCount.max).toBeLessThanOrEqual(10);
  });
});

// =========================================================
// runReconciliation Tests
// =========================================================

describe('donationReconciliationWorker - runReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  it('should return 0 when no unindexed audits and no orphaned sessions exist', async () => {
    getAuditRepo().findUnindexedAudits.mockResolvedValue([]);
    getSessionRepo().findGuestWalletSessionsByIds.mockResolvedValue([]);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    const result = await runReconciliation();
    expect(result).toBe(0);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledWith(100);
    expect(getSessionRepo().findOrphanedActiveSessions).toHaveBeenCalled();
  });

  it('should return correct flagged count when sessions need reconciliation', async () => {
    const sessions = [
      makeMockSession({ sessionId: 's1', walletAddress: '0x1111', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's2', walletAddress: '0x2222', status: 'ACTIVE', hasPendingDonation: false })
    ];
    const audits = [
      makeMockAudit({ sessionId: 's1', onChainTxHash: null, paymasterSponsoredGas: true }),
      makeMockAudit({ sessionId: 's2', onChainTxHash: null, paymasterSponsoredGas: true })
    ];
    getAuditRepo().findUnindexedAudits.mockResolvedValue(audits);
    getSessionRepo().findGuestWalletSessionsByIds.mockResolvedValue(sessions);
    getAuditRepo().findAuditsBySessionId.mockImplementation((id) =>
      Promise.resolve(audits.filter((a) => a.sessionId === id))
    );
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    getSessionRepo().updateGuestWalletSession.mockImplementation((id) =>
      Promise.resolve({ ...sessions.find((s) => s.sessionId === id)!, hasPendingDonation: true })
    );
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await runReconciliation();
    expect(result).toBe(2);
  });

  it('should deduplicate sessionIds before processing', async () => {
    const mockSession = makeMockSession({
      sessionId: 's-dup',
      walletAddress: '0xdup',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    const audits = Array(5).fill(null).map(() =>
      makeMockAudit({ sessionId: 's-dup', onChainTxHash: null, paymasterSponsoredGas: true })
    );
    getAuditRepo().findUnindexedAudits.mockResolvedValue(audits);
    getSessionRepo().findGuestWalletSessionsByIds.mockResolvedValue([mockSession]);
    getAuditRepo().findAuditsBySessionId.mockResolvedValue(audits);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({ ...mockSession, hasPendingDonation: true });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await runReconciliation();
    expect(getSessionRepo().findGuestWalletSessionsByIds).toHaveBeenCalledTimes(1);
    expect(result).toBe(1);
  });

  it('should also process orphaned sessions alongside audit-based sessions', async () => {
    const auditSession = makeMockSession({ sessionId: 's-audit', walletAddress: '0xaaaa', status: 'ACTIVE', hasPendingDonation: false });
    const orphanSession = makeMockSession({ sessionId: 's-orphan', walletAddress: '0xbbbb', status: 'ACTIVE', hasPendingDonation: false });
    const auditRecords = [makeMockAudit({ sessionId: 's-audit', onChainTxHash: null, paymasterSponsoredGas: true })];
    getAuditRepo().findUnindexedAudits.mockResolvedValue(auditRecords);
    getSessionRepo().findGuestWalletSessionsByIds.mockResolvedValue([auditSession]);
    getAuditRepo().findAuditsBySessionId.mockResolvedValue(auditRecords);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([orphanSession]);
    getSessionRepo().updateGuestWalletSession.mockImplementation((id) =>
      Promise.resolve({ sessionId: id, hasPendingDonation: true } as never)
    );
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await runReconciliation();
    expect(result).toBe(2);
    expect(getSessionRepo().findOrphanedActiveSessions).toHaveBeenCalled();
  });

  it('should exclude orphaned sessions already covered by audit sessionIds', async () => {
    const session = makeMockSession({ sessionId: 's-both', walletAddress: '0xaaaa', status: 'ACTIVE', hasPendingDonation: false });
    const auditRecords = [makeMockAudit({ sessionId: 's-both', onChainTxHash: null, paymasterSponsoredGas: true })];
    getAuditRepo().findUnindexedAudits.mockResolvedValue(auditRecords);
    getSessionRepo().findGuestWalletSessionsByIds.mockResolvedValue([session]);
    getAuditRepo().findAuditsBySessionId.mockResolvedValue(auditRecords);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([session]);
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({ ...session, hasPendingDonation: true });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await runReconciliation();
    expect(result).toBe(1);
  });
});

// =========================================================
// Edge Cases Tests
// =========================================================

describe('donationReconciliationWorker - Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  it('should handle deduplication: 5 audits all for same sessionId → counted once', async () => {
    const mockSession = makeMockSession({
      sessionId: 'session-many-audits',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    const mockAudits = Array(5).fill(null).map((_, i) =>
      makeMockAudit({ sessionId: 'session-many-audits', onChainTxHash: i === 0 ? '0xhash' : null, paymasterSponsoredGas: true })
    );
    getAuditRepo().findUnindexedAudits.mockResolvedValue(mockAudits.filter((a) => a.onChainTxHash === null));
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({ ...mockSession, hasPendingDonation: true });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await reconcileSession('session-many-audits', mockSession, mockAudits);
    expect(result).toBe(true);
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledTimes(1);
  });

  it('should handle error resilience: one session errors → others still processed', async () => {
    const sessions = [
      makeMockSession({ sessionId: 's1', walletAddress: '0xs1', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's2', walletAddress: '0xs2', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's3', walletAddress: '0xs3', status: 'ACTIVE', hasPendingDonation: false })
    ];
    const audits = sessions.map((s) =>
      makeMockAudit({ sessionId: s.sessionId, onChainTxHash: null, paymasterSponsoredGas: true })
    );
    getAuditRepo().findUnindexedAudits.mockResolvedValue(audits);
    getSessionRepo().updateGuestWalletSession.mockImplementation((id) =>
      Promise.resolve({ ...sessions.find((sess) => sess.sessionId === id)!, hasPendingDonation: true })
    );
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockImplementation((addr: string) => {
      if (addr === '0xs2') { throw new Error('RPC error'); }
      return Promise.resolve(BigInt(1000000));
    });
    const results = await Promise.all(
      sessions.map((s) =>
        reconcileSession(s.sessionId, s, audits.filter((a) => a.sessionId === s.sessionId))
      )
    );
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(true);
  });

  it('should handle error resilience: all sessions error → return 0 flagged', async () => {
    const sessions = [
      makeMockSession({ sessionId: 's1', walletAddress: '0xs1', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's2', walletAddress: '0xs2', status: 'ACTIVE', hasPendingDonation: false })
    ];
    const audits = sessions.map((s) =>
      makeMockAudit({ sessionId: s.sessionId, onChainTxHash: null, paymasterSponsoredGas: true })
    );
    getAuditRepo().findUnindexedAudits.mockResolvedValue(audits);
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockRejectedValue(new Error('All RPC errors'));
    const results = await Promise.all(
      sessions.map((s) =>
        reconcileSession(s.sessionId, s, audits.filter((a) => a.sessionId === s.sessionId)).catch(() => false)
      )
    );
    const flaggedCount = results.filter(Boolean).length;
    expect(flaggedCount).toBe(0);
  });

  it('should handle config env var resets correctly after resetModuleState', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc1.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1111111111111111111111111111111111111111');
    mockBalanceOf.mockResolvedValue(BigInt(100));
    const result1 = await getTokenBalance('0xabc');
    expect(result1).toBe(BigInt(100));
    resetModuleState();
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc2.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x2222222222222222222222222222222222222222');
    mockBalanceOf.mockReset();
    mockBalanceOf.mockResolvedValue(BigInt(200));
    const result2 = await getTokenBalance('0xdef');
    expect(result2).toBe(BigInt(200));
  });

  it('should deduplicate 5 audits for same sessionId to 1 session', async () => {
    const mockSession = makeMockSession({
      sessionId: 'dup-session',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      hasPendingDonation: false
    });
    const unindexedAudits = Array(5).fill(null).map(() =>
      makeMockAudit({ sessionId: 'dup-session', onChainTxHash: null, paymasterSponsoredGas: true })
    );
    getSessionRepo().updateGuestWalletSession.mockResolvedValue({ ...mockSession, hasPendingDonation: true });
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const result = await reconcileSession('dup-session', mockSession, unindexedAudits);
    expect(result).toBe(true);
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledTimes(1);
  });

  it('should process 3 different sessions with 2 audits each', async () => {
    const sessions = [
      makeMockSession({ sessionId: 's1', walletAddress: '0xs1000000000000000000000000000000000000', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's2', walletAddress: '0xs2000000000000000000000000000000000000', status: 'ACTIVE', hasPendingDonation: false }),
      makeMockSession({ sessionId: 's3', walletAddress: '0xs3000000000000000000000000000000000000', status: 'ACTIVE', hasPendingDonation: false })
    ];
    const audits = sessions.flatMap((s) => [
      makeMockAudit({ sessionId: s.sessionId, onChainTxHash: null, paymasterSponsoredGas: true }),
      makeMockAudit({ sessionId: s.sessionId, onChainTxHash: null, paymasterSponsoredGas: true })
    ]);
    getSessionRepo().updateGuestWalletSession.mockImplementation((id) =>
      Promise.resolve({ ...sessions.find((s) => s.sessionId === id)!, hasPendingDonation: true })
    );
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockBalanceOf.mockResolvedValue(BigInt(1000000));
    const results = await Promise.all(
      sessions.map((s) =>
        reconcileSession(s.sessionId, s, audits.filter((a) => a.sessionId === s.sessionId))
      )
    );
    const flaggedCount = results.filter(Boolean).length;
    expect(flaggedCount).toBe(3);
    expect(getSessionRepo().updateGuestWalletSession).toHaveBeenCalledTimes(3);
  });
});

// =========================================================
// validateWorkerEnvironment Tests
// =========================================================

describe('donationReconciliationWorker - validateWorkerEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return true when all env vars are valid', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(true);
  });

  it('should return false when CHARITY_TOKEN_CONTRACT_ADDRESS is empty', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '');
    expect(validateWorkerEnvironment()).toBe(false);
  });

  it('should return false when CHARITY_TOKEN_CONTRACT_ADDRESS is not a valid EIP-55 address', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', 'not-a-valid-address');
    expect(validateWorkerEnvironment()).toBe(false);
  });

  it('should return false when BLOCKCHAIN_RPC_URL is empty', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', '');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(false);
  });

  it('should return false when BLOCKCHAIN_RPC_URL is not a valid HTTP(S) URL', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'ftp://invalid-protocol.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(false);
  });

  it('should return false when BLOCKCHAIN_RPC_URL is ws:// (WebSocket)', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'ws://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(false);
  });

  it('should accept https URL for BLOCKCHAIN_RPC_URL', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(true);
  });

  it('should accept http URL for BLOCKCHAIN_RPC_URL', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'http://localhost:8545');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    expect(validateWorkerEnvironment()).toBe(true);
  });
});

// =========================================================
// acquireDistributedLock Tests
// =========================================================

describe('donationReconciliationWorker - acquireDistributedLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
    mockRedisSetFn.mockReset();
    mockRedisGetFn.mockReset();
    mockRedisDelFn.mockReset();
    mockRedisClientReady.mockReset();
  });

  it('should return true when lock is acquired successfully', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(null),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { acquireDistributedLock } = await import('../../workers/donationReconciliationWorker');
    const result = await acquireDistributedLock();
    expect(result).toBe(true);
    expect(mockRedisSetFn).toHaveBeenCalledWith(
      'donation_reconciliation:lock',
      expect.any(String),
      { NX: true, PX: 840000 }
    );
  });

  it('should return false when lock is already held by another instance', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue(null),
      get: mockRedisGetFn.mockResolvedValue(null),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { acquireDistributedLock } = await import('../../workers/donationReconciliationWorker');
    const result = await acquireDistributedLock();
    expect(result).toBe(false);
  });

  it('should return true when Redis is not available (fallback to no lock)', async () => {
    mockRedisClientReady.mockReturnValue(null);
    const { acquireDistributedLock } = await import('../../workers/donationReconciliationWorker');
    const result = await acquireDistributedLock();
    expect(result).toBe(true);
  });

  it('should return true when Redis set throws an error', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockRejectedValue(new Error('Redis error')),
      get: mockRedisGetFn.mockResolvedValue(null),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { acquireDistributedLock } = await import('../../workers/donationReconciliationWorker');
    const result = await acquireDistributedLock();
    expect(result).toBe(true);
  });
});

// =========================================================
// releaseDistributedLock Tests
// =========================================================

describe('donationReconciliationWorker - releaseDistributedLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
    mockRedisSetFn.mockReset();
    mockRedisGetFn.mockReset();
    mockRedisDelFn.mockReset();
    mockRedisClientReady.mockReset();
  });

  it('should release lock when held by current process', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { releaseDistributedLock } = await import('../../workers/donationReconciliationWorker');
    await releaseDistributedLock();
    expect(mockRedisDelFn).toHaveBeenCalledWith('donation_reconciliation:lock');
  });

  it('should not release lock when held by different process', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue('999999'),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { releaseDistributedLock } = await import('../../workers/donationReconciliationWorker');
    await releaseDistributedLock();
    expect(mockRedisDelFn).not.toHaveBeenCalled();
  });

  it('should handle when Redis is not available', async () => {
    mockRedisClientReady.mockReturnValue(null);
    const { releaseDistributedLock } = await import('../../workers/donationReconciliationWorker');
    await releaseDistributedLock();
    expect(mockRedisGetFn).not.toHaveBeenCalled();
  });

  it('should handle Redis error gracefully', async () => {
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockRejectedValue(new Error('Redis error')),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    const { releaseDistributedLock } = await import('../../workers/donationReconciliationWorker');
    await releaseDistributedLock();
    expect(mockRedisDelFn).not.toHaveBeenCalled();
  });
});

// =========================================================
// startDonationReconciliationWorker Tests
// =========================================================

describe('donationReconciliationWorker - startDonationReconciliationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBalanceOf.mockReset();
    resetModuleState();
    mockRedisSetFn.mockReset();
    mockRedisGetFn.mockReset();
    mockRedisDelFn.mockReset();
    mockRedisClientReady.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should NOT start worker when CHARITY_TOKEN_CONTRACT_ADDRESS is invalid', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', 'invalid-address');
    startDonationReconciliationWorker();
    expect(getAuditRepo().findUnindexedAudits).not.toHaveBeenCalled();
  });

  it('should NOT start worker when BLOCKCHAIN_RPC_URL is invalid', () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'ftp://invalid.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    startDonationReconciliationWorker();
    expect(getAuditRepo().findUnindexedAudits).not.toHaveBeenCalled();
  });

  it('should call runReconciliation after the scheduled interval when env vars are valid', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    getAuditRepo().findUnindexedAudits.mockResolvedValue([]);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledWith(100);
  });

  it('should skip run when lock is held by another instance', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue(null),
      get: mockRedisGetFn.mockResolvedValue(null),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).not.toHaveBeenCalled();
  });

  it('should re-schedule itself after completing a run', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    getAuditRepo().findUnindexedAudits.mockResolvedValue([]);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledTimes(2);
  });

  it('should catch errors from runReconciliation and still reschedule', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    getAuditRepo().findUnindexedAudits.mockRejectedValue(new Error('DB error'));
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(getAuditRepo().findUnindexedAudits).toHaveBeenCalledTimes(2);
  });

  it('should release lock after successful run', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    getAuditRepo().findUnindexedAudits.mockResolvedValue([]);
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(mockRedisDelFn).toHaveBeenCalledWith('donation_reconciliation:lock');
  });

  it('should release lock even when runReconciliation throws error', async () => {
    vi.stubEnv('BLOCKCHAIN_RPC_URL', 'https://rpc.example.com');
    vi.stubEnv('CHARITY_TOKEN_CONTRACT_ADDRESS', '0x1234567890123456789012345678901234567890');
    getAuditRepo().findUnindexedAudits.mockRejectedValue(new Error('DB error'));
    getSessionRepo().findOrphanedActiveSessions.mockResolvedValue([]);
    mockRedisClientReady.mockReturnValue({
      set: mockRedisSetFn.mockResolvedValue('OK'),
      get: mockRedisGetFn.mockResolvedValue(process.pid.toString()),
      del: mockRedisDelFn.mockResolvedValue(1),
      isOpen: true
    });
    startDonationReconciliationWorker();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    expect(mockRedisDelFn).toHaveBeenCalledWith('donation_reconciliation:lock');
  });
});
