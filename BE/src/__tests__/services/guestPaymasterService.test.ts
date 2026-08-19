import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import type { GuestWalletSession } from '../../models/guestWalletSessionModel';
import type { GuestDonationRisk } from '../../models/guestDonationRiskModel';
import type { ProjectRecord } from '../../models/projectModel';

/** Setup CHARITY_TOKEN_ADDRESS trước khi import guestPaymasterService (IIFE sẽ evaluate ngay). */
process.env.CHARITY_TOKEN_ADDRESS = '0x1234567890123456789012345678901234567890';

/**
 * Import mock modules — Vitest hoisting vi.mock() đảm bảo các module này
 * đã được mock trước khi import. Dùng static import thay vì top-level await import
 * để tương thích với tsconfig "module": "CommonJS".
 */
import {
  findGuestWalletSessionById,
  updateGuestWalletSession,
  reserveDonationSlot
} from '../../repositories/guestWalletSessionRepository';

import { upsertGuestDonationRisk } from '../../repositories/guestDonationRiskRepository';

import {
  findAuditByUserOpHash,
  createAuditRecord
} from '../../repositories/anonymousDonationAuditRepository';

import { findProjectById } from '../../repositories/projectRepository';

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

vi.mock('../../config/zeroDev', () => ({
  getZeroDevConfig: vi.fn(() => ({
    paymasterUrl: 'https://paymaster.zerodev.io',
    projectId: 'test-project-id',
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    rpcUrl: 'https://polygon-amoy.drpc.org'
  }))
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionById: vi.fn(),
  updateGuestWalletSession: vi.fn(),
  reserveDonationSlot: vi.fn()
}));

vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  upsertGuestDonationRisk: vi.fn()
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  findAuditByUserOpHash: vi.fn(),
  createAuditRecord: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  findProjectById: vi.fn()
}));

/**
 * Mutable object lưu kết quả risk evaluation mà cả mock factory và tests đều truy cập.
 * Giá trị default được thiết lập trong mock factory, tests ghi đè trước khi chạy.
 */
const riskEvaluationStorage: { result: { riskScore: number; riskLevel: string; trustMultiplier: number; factors: Record<string, number>; blocked: boolean } | null } = {
  result: null
};

vi.mock('../../services/guestRiskService', () => ({
  evaluateGuestRisk: vi.fn(() => {
    if (riskEvaluationStorage.result) return Promise.resolve(riskEvaluationStorage.result);
    return Promise.resolve({
      riskScore: 30,
      riskLevel: 'LOW',
      trustMultiplier: 0.8,
      factors: { walletAgeScore: 0, ipBurstScore: 0, fingerprintReuseScore: 0, donationPatternScore: 0, sessionVelocityScore: 0 },
      blocked: false
    });
  })
}));

// Export để tests có thể ghi đè giá trị

// Mock fetch globally for all tests
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ result: { paymasterAndData: '0x', userOpHash: '0x' } })
}));

/**
 * Mock mongoose — bao gồm Schema (dùng trong model definition)
 * và startSession (dùng trong service khi gọi MongoDB transaction).
 */
vi.mock('mongoose', async () => {
  const actualMongoose = await vi.importActual<typeof import('mongoose')>('mongoose');
  const mockSession = {
    withTransaction: vi.fn(async (cb: () => Promise<unknown>) => cb()),
    endSession: vi.fn()
  };
  const Schema = (actualMongoose as { Schema?: unknown })?.Schema ?? vi.fn();
  return {
    ...(actualMongoose as object),
    Schema,
    default: {
      ...(actualMongoose as object),
      Schema,
      startSession: vi.fn().mockResolvedValue(mockSession),
      connect: vi.fn(),
      disconnect: vi.fn()
    },
    startSession: vi.fn().mockResolvedValue(mockSession),
    connect: vi.fn(),
    disconnect: vi.fn()
  };
});

/**
 * Import sau khi mock.
 */
import { decodeDonationCalldata, computeUserOpHash } from '../../services/guestPaymasterService';

/**
 * Hàm encode calldata thành hex string (ABI-encoded).
 * Format: function selector (4 bytes) + args (32 bytes each, padded).
 * donate(uint256 projectId, uint256 amount, bool isAnonymous)
 * Lưu ý: projectId phải là BigInt hoặc string số, không phải string text.
 */
function encodeCalldataHex(projectId: string | number, amount: number, isAnonymous: boolean): string {
  const iface = new ethers.Interface([
    'function donate(uint256 projectId, uint256 amount, bool isAnonymous)'
  ]);
  // projectId phải là BigInt hoặc numeric string vì contract expect uint256
  const projectIdValue = typeof projectId === 'string' ? BigInt(projectId) : BigInt(projectId);
  const amountInWei = ethers.parseUnits(amount.toString(), 18);
  const data = iface.encodeFunctionData('donate', [projectIdValue, amountInWei, isAnonymous]);
  return data;
}

/**
 * Helper function tạo mock GuestWalletSession đầy đủ.
 */
function createMockSession(overrides: Partial<{
  sessionId: string;
  walletAddress: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  donationCount: number;
  totalDonatedAmount: number;
  expiresAt: Date;
  hasPendingDonation: boolean;
}> = {}): GuestWalletSession {
  return {
    sessionId: 'test-session',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    deviceFingerprintHash: 'a'.repeat(64),
    ipAddress: '192.168.1.1',
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
    expiresAt: new Date(Date.now() + 3600000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  } as GuestWalletSession;
}

/**
 * Helper function tạo mock ProjectRecord đầy đủ.
 */
function createMockProject(overrides: Partial<{
  projectId: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'REJECTED';
}> = {}): ProjectRecord {
  return {
    projectId: 'proj-abc-123',
    organizationId: 'org-test-001',
    name: 'Test Project',
    description: 'A test project',
    goalAmount: 10000,
    deadline: new Date(Date.now() + 86400000 * 30),
    status: 'ACTIVE',
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: new Date(),
    reviewedAt: new Date(),
    reviewedBy: 'admin',
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  } as ProjectRecord;
}

describe('decodeDonationCalldata', () => {
  // Dùng BigInt-compatible string làm projectId vì contract expect uint256
  const TEST_PROJECT_ID = '1234567890';

  it('decode thành công với calldata hợp lệ', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 50, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.projectId).toBe(TEST_PROJECT_ID);
      expect(result.data.amount).toBe(50);
    }
  });

  it('decode thành công với amount decimal', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 25.5, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.amount).toBe(25.5);
    }
  });

  it('reject khi method không phải donate (sai function selector)', () => {
    // Tạo calldata với sai function selector
    const iface = new ethers.Interface(['function transfer(uint256 amount)']);
    const calldata = iface.encodeFunctionData('transfer', [BigInt(50)]);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('donate');
  });

  it('reject khi projectId quá ngắn', () => {
    // uint256 luôn >= 10 ký tự khi convert sang string
    const shortProjectId = '1';
    const calldata = encodeCalldataHex(shortProjectId, 50, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('ProjectId');
  });

  it('reject khi amount == 0', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 0, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
  });

  it('chấp nhận amount == 1 (tối thiểu)', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 1, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.amount).toBe(1);
    }
  });

  it('chấp nhận amount == 100000 (dưới tối đa 200000)', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 100000, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.amount).toBe(100000);
    }
  });

  it('reject khi amount vượt giới hạn 200000 token', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 200001, true);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('200000');
  });

  it('reject khi isAnonymous != true', () => {
    const calldata = encodeCalldataHex(TEST_PROJECT_ID, 50, false);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('ẩn danh');
  });

  it('reject khi calldata không decode được (không phải donate function)', () => {
    // ABI-encoded calldata nhưng không phải donate function selector
    const iface = new ethers.Interface(['function other(uint256 amount)']);
    const calldata = iface.encodeFunctionData('other', [BigInt(50)]);
    const result = decodeDonationCalldata(calldata);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('donate');
  });

  it('reject khi calldata không parse được (invalid hex)', () => {
    const result = decodeDonationCalldata('not-valid-hex');
    expect(result.valid).toBe(false);
  });
});

describe('computeUserOpHash', () => {
  // Dùng BigInt-compatible string làm projectId
  const TEST_PROJECT_ID = '1234567890';

  it('tạo hash deterministic — cùng input phải cho ra cùng hash', () => {
    const userOp = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const hash1 = computeUserOpHash(userOp);
    const hash2 = computeUserOpHash(userOp);
    expect(hash1).toBe(hash2);
  });

  it('tạo hash dài 66 ký tự (0x + 64 hex)', () => {
    const userOp = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const hash = computeUserOpHash(userOp);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('khác input phải cho ra hash khác nhau', () => {
    const userOp1 = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const userOp2 = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '1',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const hash1 = computeUserOpHash(userOp1);
    const hash2 = computeUserOpHash(userOp2);
    expect(hash1).not.toBe(hash2);
  });

  it('khác sender phải cho ra hash khác', () => {
    const userOp1 = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const userOp2 = {
      sender: '0x0000000000000000000000000000000000000001',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const hash1 = computeUserOpHash(userOp1);
    const hash2 = computeUserOpHash(userOp2);
    expect(hash1).not.toBe(hash2);
  });

  it('khác callData phải cho ra hash khác', () => {
    const userOp1 = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const userOp2 = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 99, true)
    };
    const hash1 = computeUserOpHash(userOp1);
    const hash2 = computeUserOpHash(userOp2);
    expect(hash1).not.toBe(hash2);
  });

  it('xử lý được callData là 0x rỗng', () => {
    const userOp = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: '0',
      initCode: '0x',
      callData: '0x'
    };
    const hash = computeUserOpHash(userOp);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('xử lý được nonce là bigint', () => {
    const userOp = {
      sender: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
      nonce: BigInt(123456789),
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    const hash = computeUserOpHash(userOp);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('không throw khi sender không phải valid address', () => {
    const userOp = {
      sender: 'not-an-address',
      nonce: '0',
      initCode: '0x',
      callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true)
    };
    expect(() => computeUserOpHash(userOp)).not.toThrow();
  });
});

/**
 * Integration tests cho sponsorGuestDonation — verify business logic validation.
 * Mỗi test tập trung vào một validation path cụ thể.
 */
describe('sponsorGuestDonation - business validations', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sponsorGuestDonation: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../services/guestPaymasterService');
    sponsorGuestDonation = mod.sponsorGuestDonation;
  });

  const activeSession = createMockSession();
  const activeProject = createMockProject({ status: 'ACTIVE' });
  const sender = '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a';
  // Dùng BigInt-compatible projectId
  const TEST_PROJECT_ID = '1234567890';

  it('reject when project does not exist', async () => {
    vi.mocked(findProjectById).mockResolvedValue(null);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'nonexistent-project', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Dự án không tồn tại.');
  });

  it('reject when project is not ACTIVE', async () => {
    vi.mocked(findProjectById).mockResolvedValue(createMockProject({ status: 'COMPLETED' }));
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Dự án không còn nhận donation.');
  });

  it('reject when amount in body does not match calldata (tampering)', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 50, true) }, projectId: 'proj-abc-123', amount: 100, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Số tiền donation không khớp với calldata.');
  });

  it('reject when donation quota exceeded', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(createMockSession({ donationCount: 3 }));

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Quota đã hết hoặc có donation đang chờ');
  });

  it('reject when session expired', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(createMockSession({ expiresAt: new Date(Date.now() - 1000) }));

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('hết hạn');
  });

  it('reject when session status is not ACTIVE', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(createMockSession({ status: 'EXPIRED' }));

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('không thể sponsor');
  });

  it('reject when calldata method is not donate', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);

    // Tạo calldata với sai function selector
    const iface = new ethers.Interface(['function transfer(uint256 amount)']);
    const calldata = iface.encodeFunctionData('transfer', [BigInt(10)]);

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: calldata }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Calldata không phải donate function');
  });

  it('reject when calldata isAnonymous is false', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, false) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('ẩn danh');
  });

  it('reject when hasPendingDonation is true (conflict)', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(createMockSession({ hasPendingDonation: true }));

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('đang chờ');
  });

  it('reject when total amount would exceed session limit', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(createMockSession({ donationCount: 1, totalDonatedAmount: 199 * 100 }));

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('Quota đã hết');
  });

  it('reject when userOpHash is duplicate', async () => {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);
    vi.mocked(findAuditByUserOpHash).mockResolvedValue(
      { auditId: 'existing-id', sessionId: 'test-session' } as unknown as Awaited<ReturnType<typeof findAuditByUserOpHash>>
    );

    await expect(
      sponsorGuestDonation(
        { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
        '192.168.1.1', 'TestBrowser'
      )
    ).rejects.toThrow('đã được sponsor');
  });
});

/**
 * Tests cho Paymaster routing (Free vs Token).
 * Mỗi test set mock riêng để tránh interference giữa các cases.
 */
describe('sponsorGuestDonation - Paymaster routing', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sponsorGuestDonation: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../services/guestPaymasterService');
    sponsorGuestDonation = mod.sponsorGuestDonation;
  });

  const sender = '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a';
  const activeSession = createMockSession();
  const activeProject = createMockProject({ status: 'ACTIVE' });
  const TEST_PROJECT_ID = '1234567890';

  function setupBaseMocks() {
    vi.mocked(findProjectById).mockResolvedValue(activeProject);
    vi.mocked(findGuestWalletSessionById).mockResolvedValue(activeSession);
    vi.mocked(upsertGuestDonationRisk).mockResolvedValue(null as unknown as GuestDonationRisk);
    vi.mocked(findAuditByUserOpHash).mockResolvedValue(null);
    vi.mocked(createAuditRecord).mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof createAuditRecord>>);
    vi.mocked(reserveDonationSlot).mockResolvedValue(activeSession as unknown as Awaited<ReturnType<typeof reserveDonationSlot>>);
  }

  it('gọi Free Paymaster khi riskScore < 70 và trả paymasterType FREE', async () => {
    setupBaseMocks();
    riskEvaluationStorage.result = {
      riskScore: 30,
      riskLevel: 'LOW',
      trustMultiplier: 0.8,
      factors: { walletAgeScore: 0, ipBurstScore: 0, fingerprintReuseScore: 0, donationPatternScore: 0, sessionVelocityScore: 0 },
      blocked: false
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { paymasterAndData: '0xmockdata', userOpHash: '0xmockspendhash' } })
    });
    global.fetch = mockFetch;

    const result = await sponsorGuestDonation(
      { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
      '192.168.1.1', 'TestBrowser'
    );

    expect(result.paymasterType).toBe('FREE');
    expect(result.gasChargeWarning).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/paymaster'), expect.any(Object));

    delete (global as Record<string, unknown>).fetch;
  });

  it('gọi Token Paymaster khi riskScore >= 70 và trả gasChargeWarning', async () => {
    setupBaseMocks();
    riskEvaluationStorage.result = {
      riskScore: 85,
      riskLevel: 'HIGH',
      trustMultiplier: 0.2,
      factors: { walletAgeScore: 0, ipBurstScore: 0, fingerprintReuseScore: 0, donationPatternScore: 0, sessionVelocityScore: 0 },
      blocked: false
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { paymasterAndData: '0xtokenpaymasterdata', userOpHash: '0xtokenuserophash' } })
    });
    global.fetch = mockFetch;

    const result = await sponsorGuestDonation(
      { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
      '192.168.1.1', 'TestBrowser'
    );

    expect(result.paymasterType).toBe('TOKEN');
    expect(result.gasChargeWarning).toBe(true);
    expect(result.gasChargeAmount).toBe(1);
    expect(result.paymasterSponsoredGas).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/token-paymaster'), expect.any(Object));

    delete (global as Record<string, unknown>).fetch;
  });

  it('trả trustMultiplier và riskScore trong response', async () => {
    setupBaseMocks();
    riskEvaluationStorage.result = {
      riskScore: 50,
      riskLevel: 'LOW',
      trustMultiplier: 0.8,
      factors: { walletAgeScore: 0, ipBurstScore: 0, fingerprintReuseScore: 0, donationPatternScore: 0, sessionVelocityScore: 0 },
      blocked: false
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { paymasterAndData: '0xmockdata', userOpHash: '0xmockspendhash' } })
    });
    global.fetch = mockFetch;

    const result = await sponsorGuestDonation(
      { unsignedUserOp: { sender, nonce: '0', initCode: '0x', callData: encodeCalldataHex(TEST_PROJECT_ID, 10, true) }, projectId: 'proj-abc-123', amount: 10, sessionId: 'test-session' },
      '192.168.1.1', 'TestBrowser'
    );

    expect(result.trustMultiplier).toBe(0.8);
    expect(result.riskScore).toBe(50);
    expect(result.sponsorshipId).toBeDefined();

    delete (global as Record<string, unknown>).fetch;
  });
});
