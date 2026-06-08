import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RiskLevel } from '../../models/guestDonationRiskModel';
import type { GuestDonationRisk } from '../../models/guestDonationRiskModel';
import type { GuestWalletSession } from '../../models/guestWalletSessionModel';

/**
 * Mock blockchainProvider — cho phép control getSharedRpcProvider() trong mỗi test.
 */
const mockProvider = {
  getCode: vi.fn()
};

vi.mock('../../services/blockchainProvider', () => ({
  getSharedRpcProvider: vi.fn(() => mockProvider),
  resetSharedRpcProvider: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  findGuestDonationRiskBySessionId: vi.fn(),
  upsertGuestDonationRisk: vi.fn()
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  countRecentSessionsByIp: vi.fn(),
  countRecentSessionsByIpExcluding: vi.fn(),
  countRecentSessionsByFingerprint: vi.fn(),
  findGuestWalletSessionById: vi.fn()
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  findAuditAmountsBySessionId: vi.fn()
}));

import {
  evaluateGuestRisk,
  evaluateAndSaveGuestRisk,
  reEvaluateGuestRiskOnly,
  computeRiskLevelAndMultiplier
} from '../../services/guestRiskService';
import {
  findGuestDonationRiskBySessionId,
  upsertGuestDonationRisk
} from '../../repositories/guestDonationRiskRepository';
import {
  countRecentSessionsByIp,
  countRecentSessionsByIpExcluding,
  countRecentSessionsByFingerprint,
  findGuestWalletSessionById
} from '../../repositories/guestWalletSessionRepository';
import { findAuditAmountsBySessionId } from '../../repositories/anonymousDonationAuditRepository';
import { getSharedRpcProvider } from '../../services/blockchainProvider';

const mockSession = {
  sessionId: 'test-session-123',
  walletAddress: '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a',
  deviceFingerprintHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
};

describe('guestRiskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockProvider.getCode).mockResolvedValue('0xdeployed');
    vi.mocked(countRecentSessionsByIp).mockResolvedValue(0);
    vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(0);
    vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(0);
    vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // checkWalletAge
  // -------------------------------------------------------------------------
  describe('checkWalletAge', () => {
    it('trả về +0 khi wallet đã deployed on-chain (getCode trả về code khác 0x)', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0xdeployed');
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.walletAgeScore).toBe(0);
    });

    it('trả về +20 khi wallet counterfactual (getCode trả về 0x)', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.walletAgeScore).toBe(20);
    });

    it('trả về +0 khi getCode throw exception (fail-safe, không crash)', async () => {
      vi.mocked(mockProvider.getCode).mockRejectedValue(new Error('RPC error'));
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.walletAgeScore).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkIPBurst
  // -------------------------------------------------------------------------
  describe('checkIPBurst', () => {
    it('trả về +0 khi IP có <3 sessions gần đây', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(0);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.ipBurstScore).toBe(0);
    });

    it('trả về +30 khi IP có ≥3 sessions gần đây', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.ipBurstScore).toBe(30);
    });

    it('trả về +0 khi countRecentSessionsByIp throw — fail-safe (không inflate score)', async () => {
      vi.mocked(countRecentSessionsByIp).mockRejectedValue(new Error('DB error'));
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.ipBurstScore).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkFingerprintReuse
  // -------------------------------------------------------------------------
  describe('checkFingerprintReuse', () => {
    it('trả về +0 khi fingerprint có <3 sessions gần đây', async () => {
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(0);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.fingerprintReuseScore).toBe(0);
    });

    it('trả về +25 khi fingerprint có ≥3 sessions gần đây', async () => {
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.fingerprintReuseScore).toBe(25);
    });

    it('trả về +0 khi countRecentSessionsByFingerprint throw — fail-safe (không inflate score)', async () => {
      vi.mocked(countRecentSessionsByFingerprint).mockRejectedValue(new Error('DB error'));
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.fingerprintReuseScore).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkDonationPattern (S3 fix: require ≥3 donations)
  // -------------------------------------------------------------------------
  describe('checkDonationPattern', () => {
    it('trả về +0 khi không có audit nào', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });

    it('trả về +0 khi chỉ có 1 audit (cần ≥3 để tránh false positive)', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });

    it('trả về +0 khi có 2 donations cùng amount (không đủ ≥3 — S3 fix tránh false positive)', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });

    it('trả về +0 khi 2 donations có amounts khác nhau', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 200]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });

    it('trả về +15 khi ≥3 donations cùng amount', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(15);
    });

    it('trả về +0 khi ≥3 donations có amounts khác nhau', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 200, 300]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });

    it('trả về +0 khi findAuditAmountsBySessionId throw — fail-safe', async () => {
      vi.mocked(findAuditAmountsBySessionId).mockRejectedValue(new Error('DB error'));
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.donationPatternScore).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkSessionVelocity (S1 fix: dùng countRecentSessionsByIpExcluding)
  // -------------------------------------------------------------------------
  describe('checkSessionVelocity', () => {
    it('trả về +0 khi không có session nào khác trong 60s (count = 0)', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(0);
      const createdAt = new Date('2025-01-01T12:00:00Z');
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1', createdAt);
      expect(result.factors.sessionVelocityScore).toBe(0);
    });

    it('trả về +10 khi có >=1 session khác trong 60s (count = 1 → automated)', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(1);
      const createdAt = new Date('2025-01-01T12:00:00Z');
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1', createdAt);
      expect(result.factors.sessionVelocityScore).toBe(10);
    });

    it('trả về +10 khi có >=2 sessions khác trong 60s (count = 2 → automated)', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      const createdAt = new Date('2025-01-01T12:00:00Z');
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1', createdAt);
      expect(result.factors.sessionVelocityScore).toBe(10);
    });

    it('trả về +0 khi không truyền sessionCreatedAt (dùng current time)', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(0);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.sessionVelocityScore).toBe(0);
    });

    it('trả về +0 khi countRecentSessionsByIpExcluding throw (fail-safe trả 0)', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockRejectedValue(new Error('DB error'));
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.factors.sessionVelocityScore).toBe(0);
    });

    it('countRecentSessionsByIpExcluding được gọi với excludeSessionId = session.sessionId', async () => {
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(0);
      const createdAt = new Date('2025-01-01T12:00:00Z');
      await evaluateGuestRisk(mockSession, '192.168.1.1', createdAt);
      expect(countRecentSessionsByIpExcluding).toHaveBeenCalledWith(
        '192.168.1.1',
        expect.any(Date),
        mockSession.sessionId
      );
    });
  });

  // -------------------------------------------------------------------------
  // computeRiskLevelAndMultiplier — boundary tests (T3 fix)
  // -------------------------------------------------------------------------
  describe('computeRiskLevelAndMultiplier — boundaries', () => {
    it('SAFE (score = 0)', () => {
      expect(computeRiskLevelAndMultiplier(0)).toEqual({ riskLevel: 'SAFE', trustMultiplier: 1.0 });
    });

    it('SAFE (score = 25)', () => {
      expect(computeRiskLevelAndMultiplier(25)).toEqual({ riskLevel: 'SAFE', trustMultiplier: 1.0 });
    });

    it('LOW (score = 26)', () => {
      expect(computeRiskLevelAndMultiplier(26)).toEqual({ riskLevel: 'LOW', trustMultiplier: 0.8 });
    });

    it('LOW (score = 50)', () => {
      expect(computeRiskLevelAndMultiplier(50)).toEqual({ riskLevel: 'LOW', trustMultiplier: 0.8 });
    });

    it('MEDIUM (score = 51)', () => {
      expect(computeRiskLevelAndMultiplier(51)).toEqual({ riskLevel: 'MEDIUM', trustMultiplier: 0.5 });
    });

    it('MEDIUM (score = 69)', () => {
      expect(computeRiskLevelAndMultiplier(69)).toEqual({ riskLevel: 'MEDIUM', trustMultiplier: 0.5 });
    });

    it('HIGH (score = 70) — boundary MEDIUM/HIGH = 70', () => {
      expect(computeRiskLevelAndMultiplier(70)).toEqual({ riskLevel: 'HIGH', trustMultiplier: 0.2 });
    });

    it('HIGH (score = 90)', () => {
      expect(computeRiskLevelAndMultiplier(90)).toEqual({ riskLevel: 'HIGH', trustMultiplier: 0.2 });
    });

    it('CRITICAL (score = 91)', () => {
      expect(computeRiskLevelAndMultiplier(91)).toEqual({ riskLevel: 'CRITICAL', trustMultiplier: 0.2 });
    });

    it('CRITICAL (score = 100)', () => {
      expect(computeRiskLevelAndMultiplier(100)).toEqual({ riskLevel: 'CRITICAL', trustMultiplier: 0.2 });
    });
  });

  // -------------------------------------------------------------------------
  // Risk level integration tests
  // -------------------------------------------------------------------------
  describe('risk level integration', () => {
    it('SAFE khi không có suspicious factors', async () => {
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskLevel).toBe('SAFE');
      expect(result.trustMultiplier).toBe(1.0);
      expect(result.blocked).toBe(false);
    });

    it('LOW khi riskScore = 40 (IP burst + session velocity)', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBe(40);
      expect(result.riskLevel).toBe('LOW');
      expect(result.trustMultiplier).toBe(0.8);
    });

    it('MEDIUM khi riskScore = 65 (IP burst + fingerprint + velocity)', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBe(65);
      expect(result.riskLevel).toBe('MEDIUM');
      expect(result.trustMultiplier).toBe(0.5);
    });

    it('HIGH khi riskScore = 80 (IP + fingerprint + donation pattern ≥3 + velocity)', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBe(80);
      expect(result.riskLevel).toBe('HIGH');
      expect(result.trustMultiplier).toBe(0.2);
      expect(result.blocked).toBe(false);
    });

    it('CRITICAL khi riskScore >= 91 (tất cả factors max)', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      // walletAge(20) + IP(30) + fingerprint(25) + donationPattern(15) + velocity(10) = 100
      expect(result.riskScore).toBe(100);
      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.blocked).toBe(true);
    });

    it('trustMultiplier = 0.2 cho CRITICAL (không bằng 0)', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.trustMultiplier).toBe(0.2);
    });
  });

  // -------------------------------------------------------------------------
  // evaluateGuestRisk - tổng hợp
  // -------------------------------------------------------------------------
  describe('evaluateGuestRisk - tổng hợp', () => {
    it('trả về đầy đủ factors và blocked = false cho SAFE', async () => {
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBe(0);
      expect(result.riskLevel).toBe('SAFE');
      expect(result.blocked).toBe(false);
      expect(result.factors).toEqual({
        walletAgeScore: 0,
        ipBurstScore: 0,
        fingerprintReuseScore: 0,
        donationPatternScore: 0,
        sessionVelocityScore: 0
      });
    });

    it('blocked = true chỉ khi CRITICAL', async () => {
      let result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.blocked).toBe(false);

      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBe(65);
      expect(result.riskLevel).toBe('MEDIUM');
      expect(result.blocked).toBe(false);

      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      // walletAge(20) + IP(30) + fingerprint(25) + donationPattern(15) + velocity(10) = 100
      expect(result.riskScore).toBe(100);
      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.blocked).toBe(true);
    });

    it('getSharedRpcProvider được gọi trong mỗi evaluateGuestRisk', async () => {
      await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(vi.mocked(getSharedRpcProvider)).toHaveBeenCalled();
    });

    it('riskScore không vượt quá 100 (Math.min cap)', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(10);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      const result = await evaluateGuestRisk(mockSession, '192.168.1.1');
      expect(result.riskScore).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  // evaluateAndSaveGuestRisk
  // -------------------------------------------------------------------------
  describe('evaluateAndSaveGuestRisk', () => {
    it('gọi upsertGuestDonationRisk sau khi evaluate với đầy đủ factors', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(upsertGuestDonationRisk).mockResolvedValue({
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 40,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8,
        factors: {
          walletAgeScore: 0,
          ipBurstScore: 30,
          fingerprintReuseScore: 0,
          donationPatternScore: 0,
          sessionVelocityScore: 10
        },
        blocked: false,
        blockedAt: null,
        blockedReason: null,
        clusterSuspect: false,
        clusterId: null,
        lastEvaluatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      } as GuestDonationRisk);

      const result = await evaluateAndSaveGuestRisk(mockSession, '192.168.1.1');

      expect(upsertGuestDonationRisk).toHaveBeenCalledTimes(1);
      expect(upsertGuestDonationRisk).toHaveBeenCalledWith(
        mockSession.sessionId,
        expect.objectContaining({
          sessionId: mockSession.sessionId,
          riskScore: 40,
          riskLevel: 'LOW',
          factors: expect.objectContaining({
            ipBurstScore: 30,
            sessionVelocityScore: 10
          }),
          blocked: false
        })
      );
      expect(result.riskLevel).toBe('LOW');
    });

    it('blockedAt và blockedReason là null khi không block', async () => {
      vi.mocked(upsertGuestDonationRisk).mockResolvedValue({
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 0,
        riskLevel: 'SAFE' as RiskLevel,
        trustMultiplier: 1.0,
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
        lastEvaluatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      } as GuestDonationRisk);

      await evaluateAndSaveGuestRisk(mockSession, '192.168.1.1');

      expect(upsertGuestDonationRisk).toHaveBeenCalledWith(
        mockSession.sessionId,
        expect.objectContaining({
          blocked: false,
          blockedAt: null,
          blockedReason: null
        })
      );
    });

    it('blockedAt và blockedReason được set khi CRITICAL', async () => {
      vi.mocked(mockProvider.getCode).mockResolvedValue('0x');
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([100, 100, 100]);
      vi.mocked(upsertGuestDonationRisk).mockResolvedValue({
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 91,
        riskLevel: 'CRITICAL' as RiskLevel,
        trustMultiplier: 0.2,
        factors: {
          walletAgeScore: 20,
          ipBurstScore: 30,
          fingerprintReuseScore: 25,
          donationPatternScore: 15,
          sessionVelocityScore: 10
        },
        blocked: true,
        blockedAt: new Date(),
        blockedReason: 'Risk score exceeds threshold',
        clusterSuspect: false,
        clusterId: null,
        lastEvaluatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      } as GuestDonationRisk);

      await evaluateAndSaveGuestRisk(mockSession, '192.168.1.1');

      expect(upsertGuestDonationRisk).toHaveBeenCalledWith(
        mockSession.sessionId,
        expect.objectContaining({
          blocked: true,
          blockedAt: expect.any(Date),
          blockedReason: 'Risk score exceeds threshold'
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // reEvaluateGuestRiskOnly
  // -------------------------------------------------------------------------
  describe('reEvaluateGuestRiskOnly', () => {
    const mockIpAddress = '192.168.1.100';

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(mockProvider.getCode).mockResolvedValue('0xdeployed');
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(0);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(0);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(0);
      vi.mocked(findAuditAmountsBySessionId).mockResolvedValue([]);
    });

    it('throws ApplicationError khi risk record không tồn tại', async () => {
      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue(null);
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        deviceFingerprintHash: mockSession.deviceFingerprintHash,
        ipAddress: '127.0.0.1',
        userAgent: 'test',
        status: 'ACTIVE' as const,
        donationCount: 0,
        totalDonatedAmount: 0,
        totalSponsoredGas: 0,
        renewalCount: 0,
        claimedByUserId: null,
        serverSalt: '00',
        hasPendingDonation: false,
        pendingAlertSentAt: null,
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      } as GuestWalletSession);

      await expect(reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress))
        .rejects.toThrow('Không tìm thấy risk record cho phiên này.');
    });

    it('throws ApplicationError khi session không tồn tại', async () => {
      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue({
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 50,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8,
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
        lastEvaluatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      } as GuestDonationRisk);
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      await expect(reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress))
        .rejects.toThrow('Không tìm thấy session cho phiên này.');
    });

    it('trả về RiskEvaluationResult đúng khi cả hai tồn tại', async () => {
      const mockRiskRecord = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 30,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8
      } as GuestDonationRisk;
      const mockDbSession = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        deviceFingerprintHash: 're-eval-fingerprint',
        createdAt: new Date('2025-01-01T12:00:00Z')
      } as GuestWalletSession;

      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue(mockRiskRecord);
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockDbSession);

      const result = await reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress);

      expect(result).toBeDefined();
      expect(result.riskLevel).toBe('SAFE');
      expect(result.blocked).toBe(false);
    });

    it('trả về kết quả với fingerprint factor từ session (không phải risk record)', async () => {
      const mockRiskRecord = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 50,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8
      } as GuestDonationRisk;
      const mockDbSession = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        deviceFingerprintHash: 'updated-fingerprint-hash',
        createdAt: new Date('2025-01-01T12:00:00Z')
      } as GuestWalletSession;

      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue(mockRiskRecord);
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockDbSession);
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);

      const result = await reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress);

      expect(result.factors.fingerprintReuseScore).toBe(25);
    });

    it('trả về kết quả với IP burst factor khi có nhiều sessions gần đây', async () => {
      const mockRiskRecord = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 30,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8
      } as GuestDonationRisk;
      const mockDbSession = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        deviceFingerprintHash: mockSession.deviceFingerprintHash,
        createdAt: new Date('2025-01-01T12:00:00Z')
      } as GuestWalletSession;

      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue(mockRiskRecord);
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockDbSession);
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);
      vi.mocked(countRecentSessionsByIpExcluding).mockResolvedValue(2);

      const result = await reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress);

      expect(result.factors.ipBurstScore).toBe(30);
      expect(result.riskScore).toBe(40);
      expect(result.riskLevel).toBe('LOW');
    });

    it('throws ApplicationError khi findGuestWalletSessionById throw', async () => {
      const mockRiskRecord = {
        sessionId: mockSession.sessionId,
        walletAddress: mockSession.walletAddress,
        riskScore: 30,
        riskLevel: 'LOW' as RiskLevel,
        trustMultiplier: 0.8
      } as GuestDonationRisk;

      vi.mocked(findGuestDonationRiskBySessionId).mockResolvedValue(mockRiskRecord);
      vi.mocked(findGuestWalletSessionById).mockRejectedValue(new Error('Database connection failed'));

      await expect(reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress))
        .rejects.toThrow('Không thể đánh giá risk. Vui lòng thử lại sau.');
    });

    it('throws ApplicationError khi findGuestDonationRiskBySessionId throw', async () => {
      vi.mocked(findGuestDonationRiskBySessionId).mockRejectedValue(new Error('Database connection failed'));

      await expect(reEvaluateGuestRiskOnly(mockSession.sessionId, mockIpAddress))
        .rejects.toThrow('Không thể đánh giá risk. Vui lòng thử lại sau.');
    });
  });
});
