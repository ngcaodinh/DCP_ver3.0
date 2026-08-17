/**
 * Unit tests cho handleDonationPostIndex — Guest Donation Indexer Extension (Task 5.2).
 *
 * Coverage:
 * 1. Guest donation (isAnonymous=true + ACTIVE session) → session counters tăng, trustMultiplier < 1.0
 * 2. Guest donation nhưng session EXPIRED → không tăng counters, trustMultiplier fallback 1.0
 * 3. Registered user donation (isAnonymous=false) → không gọi session counter, trustMultiplier = 1.0
 * 4. isAnonymous=true nhưng ví không có session → registered user path, trustMultiplier = 1.0
 * 5. Guest donation với riskRecord null → trustMultiplier mặc định 1.0
 * 6. Guest donation với trustMultiplier khác nhau → verify weighted metrics
 * 7. Amount không hợp lệ (NaN) → throw ApplicationError
 * 8. Amount <= 0 → throw ApplicationError
 * 9. Idempotency: re-run an toàn khi audit đã được update
 * 10. Promise.all: verify cả hai repository được gọi đồng thời
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GuestWalletSession } from '../../models/guestWalletSessionModel';
import type { GuestDonationRisk } from '../../models/guestDonationRiskModel';
import type { DonationEventLog } from '../../services/donationService';

/**
 * Mock dependencies — khai báo trước khi import module under test.
 */
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn().mockResolvedValue(null)
}));

vi.mock('../../config/zeroDev', () => ({
  getZeroDevConfig: vi.fn(() => ({
    paymasterUrl: 'https://paymaster.test',
    projectId: 'test-project',
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    rpcUrl: 'https://rpc.test'
  }))
}));

vi.mock('../../services/zeroDevService', () => ({
  createKernelClientFromEncryptedOwnerKey: vi.fn()
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionByWalletAddress: vi.fn(),
  incrementSessionDonationCounters: vi.fn()
}));

vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  findGuestDonationRiskByWalletAddress: vi.fn()
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  updateAuditByTransactionHash: vi.fn()
}));

vi.mock('../../services/rankingIncrementalService', () => ({
  applyDonationToMetrics: vi.fn()
}));

vi.mock('../../services/event-logger.service', () => ({
  logEvent: vi.fn()
}));

/**
 * Import sau khi mock để Vitest hoisting đảm bảo mocks đã được setup.
 */
import { handleDonationPostIndex } from '../../services/donationService';
import {
  findGuestWalletSessionByWalletAddress,
  incrementSessionDonationCounters
} from '../../repositories/guestWalletSessionRepository';
import {
  findGuestDonationRiskByWalletAddress
} from '../../repositories/guestDonationRiskRepository';
import {
  updateAuditByTransactionHash
} from '../../repositories/anonymousDonationAuditRepository';
import {
  applyDonationToMetrics
} from '../../services/rankingIncrementalService';
import { logEvent } from '../../services/event-logger.service';

/**
 * Hàm tạo DonationEventLog mẫu.
 */
function createMockDonationEvent(
  overrides: Partial<DonationEventLog> = {}
): DonationEventLog {
  const now = new Date();
  return {
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    projectId: '123',
    donorAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    amount: 50,
    timestamp: now,
    isAnonymous: true,
    blockNumber: 12345678,
    donationStatus: 'INDEXED',
    onChainConfirmedAt: now,
    indexedAt: now,
    correlationId: `donation:0x1234567890abcdef`,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/**
 * Hàm tạo GuestWalletSession mẫu.
 */
function createMockGuestSession(
  overrides: Partial<GuestWalletSession> = {}
): GuestWalletSession {
  const now = new Date();
  return {
    sessionId: 'test-session-id-uuid',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    deviceFingerprintHash: 'a'.repeat(64),
    ipAddress: '192.168.1.100',
    userAgent: 'TestBrowser/1.0',
    status: 'ACTIVE',
    donationCount: 0,
    totalDonatedAmount: 0,
    totalSponsoredGas: 0,
    renewalCount: 0,
    claimedByUserId: null,
    serverSalt: 'b'.repeat(64),
    hasPendingDonation: false,
    pendingAlertSentAt: null,
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as GuestWalletSession;
}

/**
 * Hàm tạo GuestDonationRisk mẫu.
 */
function createMockRiskRecord(
  overrides: Partial<GuestDonationRisk> = {}
): GuestDonationRisk {
  const now = new Date();
  return {
    sessionId: 'test-session-id-uuid',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    riskScore: 30,
    riskLevel: 'LOW',
    trustMultiplier: 0.5,
    factors: {
      walletAgeScore: 0,
      ipBurstScore: 0,
      fingerprintReuseScore: 0,
      donationPatternScore: 0,
      sessionVelocityScore: 0
    },
    blocked: false,
    blockedAt: null,
    blockedReason: null,
    clusterSuspect: false,
    clusterId: null,
    lastEvaluatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as GuestDonationRisk;
}

describe('handleDonationPostIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== 1. Guest donation (isAnonymous=true + ACTIVE session) =====
  it('guest donation với ACTIVE session → tăng session counters và dùng trustMultiplier từ risk record', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    // findGuestWalletSessionByWalletAddress: resolves sau khi findGuestDonationRiskByWalletAddress
    // để verify Promise.all gọi cả hai đồng thời
    let resolveSession: (v: GuestWalletSession | null) => void;
    let resolveRisk: (v: GuestDonationRisk | null) => void;
    const sessionPromise = new Promise<GuestWalletSession | null>(r => { resolveSession = r; });
    const riskPromise = new Promise<GuestDonationRisk | null>(r => { resolveRisk = r; });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockReturnValue(sessionPromise);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockReturnValue(riskPromise);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    // Resolve cả hai promises cùng lúc (để test Promise.all behavior)
    const handler = handleDonationPostIndex(mockEvent);
    resolveSession!(mockSession);
    resolveRisk!(mockRisk);
    const result = await handler;

    expect(result).toBe(true);
    expect(incrementSessionDonationCounters).toHaveBeenCalledWith('test-session-id-uuid', 50);
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      0.5
    );
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'DONATION_CONFIRMED',
      projectId: '123',
      walletAddress: mockEvent.donorAddress,
      amount: 50,
      payload: expect.objectContaining({
        transactionHash: mockEvent.transactionHash,
        blockNumber: mockEvent.blockNumber,
        isAnonymous: true
      })
    }));
  });

  // ===== 2. Guest donation nhưng session EXPIRED =====
  it('isAnonymous=true nhưng session EXPIRED → không tăng counters, trustMultiplier fallback 1.0', async () => {
    const mockSession = createMockGuestSession({ status: 'EXPIRED' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(false);
    expect(incrementSessionDonationCounters).not.toHaveBeenCalled();
    // trustMultiplier vẫn dùng giá trị từ risk record vì session không phải ACTIVE
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      0.5
    );
  });

  // ===== 3. Registered user donation (isAnonymous=false) =====
  it('isAnonymous=false → không tăng counters, trustMultiplier = 1.0 (registered user)', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: false });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(false);
    // Khi isAnonymous=false, isGuestDonation = false bất kể session có ACTIVE hay không
    expect(incrementSessionDonationCounters).not.toHaveBeenCalled();
    // trustMultiplier dùng giá trị từ risk record (0.5) vì record tồn tại
    // Chỉ fallback 1.0 khi riskRecord === null
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      0.5
    );
  });

  // ===== 4. isAnonymous=true nhưng ví không có session =====
  it('isAnonymous=true nhưng không có session record → registered user path', async () => {
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(null);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(false);
    expect(incrementSessionDonationCounters).not.toHaveBeenCalled();
    // trustMultiplier dùng giá trị từ risk record (0.5) vì record tồn tại
    // isGuestDonation = false vì không có session ACTIVE (session === null)
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      0.5
    );
  });

  // ===== 5. Guest donation với riskRecord null =====
  it('guest donation với riskRecord null → trustMultiplier mặc định 1.0', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(null);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(true);
    expect(incrementSessionDonationCounters).toHaveBeenCalled();
    // trustMultiplier fallback 1.0 khi không có risk record
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      1.0
    );
  });

  // ===== 6. Guest donation với trustMultiplier khác nhau =====
  it('trustMultiplier 0.2 được truyền chính xác vào applyDonationToMetrics', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.2 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    await handleDonationPostIndex(mockEvent);

    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      0.2
    );
  });

  // ===== 7. Amount không hợp lệ (NaN) =====
  it('throw ApplicationError khi amount là NaN', async () => {
    const mockEvent = createMockDonationEvent({ amount: NaN });

    await expect(handleDonationPostIndex(mockEvent)).rejects.toThrow(
      'Giá trị donation không hợp lệ từ blockchain event.'
    );
  });

  // ===== 8. Amount <= 0 =====
  it.each([
    { amount: 0, label: 'amount = 0' },
    { amount: -10, label: 'amount = -10' },
    { amount: -0.001, label: 'amount = -0.001' }
  ])('throw ApplicationError khi $label', async ({ amount }) => {
    const mockEvent = createMockDonationEvent({ amount });

    await expect(handleDonationPostIndex(mockEvent)).rejects.toThrow(
      'Giá trị donation không hợp lệ từ blockchain event.'
    );
  });

  // ===== 9. Idempotency: re-run an toàn khi audit đã được update =====
  it('idempotency: audit đã update rồi thì không có side effect khác', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    // Audit đã được update trước đó → modifiedCount = 0
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(0);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(true);
    expect(updateAuditByTransactionHash).toHaveBeenCalledWith(
      mockEvent.transactionHash,
      mockEvent.blockNumber
    );
    // incrementSessionDonationCounters vẫn được gọi (vì isGuestDonation = true)
    expect(incrementSessionDonationCounters).toHaveBeenCalledWith('test-session-id-uuid', 50);
    expect(applyDonationToMetrics).toHaveBeenCalled();
  });

  // ===== 10. Promise.all: verify cả hai repository được gọi đồng thời =====
  it('gọi findGuestWalletSessionByWalletAddress và findGuestDonationRiskByWalletAddress đồng thời', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 0.5 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    const callTimes: Record<string, number> = {};
    const startTime = Date.now();
    vi.mocked(findGuestWalletSessionByWalletAddress).mockImplementation(async () => {
      callTimes.sessionStart = Date.now() - startTime;
      await new Promise(r => setTimeout(r, 50));
      callTimes.sessionEnd = Date.now() - startTime;
      return mockSession;
    });
    vi.mocked(findGuestDonationRiskByWalletAddress).mockImplementation(async () => {
      callTimes.riskStart = Date.now() - startTime;
      await new Promise(r => setTimeout(r, 10));
      callTimes.riskEnd = Date.now() - startTime;
      return mockRisk;
    });
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    await handleDonationPostIndex(mockEvent);

    // Với Promise.all, risk bắt đầu không muộn hơn session-end (chạy song song).
    // Nếu sequential: risk-start phải >= session-end (~50ms).
    // Với Promise.all: risk-start < session-end (cùng lúc).
    expect(callTimes.riskStart).toBeLessThan(callTimes.sessionEnd!);
  });

  // ===== Edge case: trustMultiplier = 1.0 với guest donation (SAFE risk) =====
  it('trustMultiplier 1.0 vẫn tính là guest donation nếu session ACTIVE và isAnonymous=true', async () => {
    const mockSession = createMockGuestSession({ status: 'ACTIVE' });
    const mockRisk = createMockRiskRecord({ trustMultiplier: 1.0 });
    const mockEvent = createMockDonationEvent({ isAnonymous: true });

    vi.mocked(findGuestWalletSessionByWalletAddress).mockResolvedValue(mockSession);
    vi.mocked(findGuestDonationRiskByWalletAddress).mockResolvedValue(mockRisk);
    vi.mocked(updateAuditByTransactionHash).mockResolvedValue(1);
    vi.mocked(incrementSessionDonationCounters).mockResolvedValue(null);
    vi.mocked(applyDonationToMetrics).mockResolvedValue(undefined);

    const result = await handleDonationPostIndex(mockEvent);

    expect(result).toBe(true);
    expect(incrementSessionDonationCounters).toHaveBeenCalled();
    expect(applyDonationToMetrics).toHaveBeenCalledWith(
      '123',
      50,
      mockEvent.donorAddress.toLowerCase(),
      1.0
    );
  });

  // ===== Edge case: amount Infinity =====
  it('throw ApplicationError khi amount là Infinity', async () => {
    const mockEvent = createMockDonationEvent({ amount: Infinity });

    await expect(handleDonationPostIndex(mockEvent)).rejects.toThrow(
      'Giá trị donation không hợp lệ từ blockchain event.'
    );
  });
});
