import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RiskLevel } from '../../models/guestDonationRiskModel';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  createGuestWalletSession: vi.fn(),
  findGuestWalletSessionById: vi.fn(),
  findGuestWalletSessionByWalletAddress: vi.fn(),
  updateGuestWalletSession: vi.fn(),
  countRecentSessionsByFingerprint: vi.fn(),
  countRecentSessionsByIp: vi.fn()
}));

vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  upsertGuestDonationRisk: vi.fn()
}));

vi.mock('../../services/guestRiskService', () => ({
  evaluateAndSaveGuestRisk: vi.fn(),
  computeRiskLevelAndMultiplier: vi.fn()
}));

vi.mock('../../config/guestJsonWebToken', () => ({
  signGuestSessionToken: vi.fn()
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-session-id-12345')
}));

import {
  createNewGuestSession,
  refreshExistingSession,
  getSessionStatus
} from '../../services/guestSessionService';
import {
  createGuestWalletSession,
  findGuestWalletSessionById,
  updateGuestWalletSession,
  countRecentSessionsByFingerprint,
  countRecentSessionsByIp
} from '../../repositories/guestWalletSessionRepository';
import {
  upsertGuestDonationRisk
} from '../../repositories/guestDonationRiskRepository';
import { evaluateAndSaveGuestRisk, computeRiskLevelAndMultiplier } from '../../services/guestRiskService';
import { signGuestSessionToken } from '../../config/guestJsonWebToken';

const CHECKSUM_ADDRESS = '0x742d35CC6634C0532925A3B844Bc9e7595F5c21a';
const LOWERCASE_ADDRESS = CHECKSUM_ADDRESS.toLowerCase();

const mockSessionData = {
  sessionId: 'test-session-id',
  walletAddress: LOWERCASE_ADDRESS,
  deviceFingerprintHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  ipAddress: '192.168.1.1',
  userAgent: 'Mozilla/5.0 Test Browser',
  status: 'ACTIVE' as const,
  donationCount: 0,
  totalDonatedAmount: 0,
  totalSponsoredGas: 0,
  renewalCount: 0,
  claimedByUserId: null,
  serverSalt: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
  smartAccountOwnerEncryptedPrivateKey: null as string | null,
  hasPendingDonation: false,
  pendingAlertSentAt: null,
  expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date()
};

function realComputeRiskLevelAndMultiplier(riskScore: number): {
  riskLevel: RiskLevel;
  trustMultiplier: number;
} {
  if (riskScore <= 25) return { riskLevel: 'SAFE' as RiskLevel, trustMultiplier: 1.0 };
  if (riskScore <= 50) return { riskLevel: 'LOW' as RiskLevel, trustMultiplier: 0.8 };
  if (riskScore < 70) return { riskLevel: 'MEDIUM' as RiskLevel, trustMultiplier: 0.5 };
  if (riskScore <= 90) return { riskLevel: 'HIGH' as RiskLevel, trustMultiplier: 0.2 };
  return { riskLevel: 'CRITICAL' as RiskLevel, trustMultiplier: 0.2 };
}

describe('guestSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(0);
    vi.mocked(countRecentSessionsByIp).mockResolvedValue(0);
    vi.mocked(createGuestWalletSession).mockResolvedValue(mockSessionData);
    vi.mocked(evaluateAndSaveGuestRisk).mockResolvedValue({} as never);
    vi.mocked(upsertGuestDonationRisk).mockResolvedValue({} as never);
    vi.mocked(computeRiskLevelAndMultiplier).mockImplementation(realComputeRiskLevelAndMultiplier);
    vi.mocked(signGuestSessionToken).mockReturnValue('mock-jwt-token');
    vi.mocked(updateGuestWalletSession).mockResolvedValue(mockSessionData);
  });

  // -------------------------------------------------------------------------
  // createNewGuestSession
  // -------------------------------------------------------------------------
  describe('createNewGuestSession', () => {
    it('tạo session thành công với đầy đủ params hợp lệ', async () => {
      const result = await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('guestSessionToken');
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('serverSalt');
      expect(result).toHaveProperty('donationQuota');
      expect(result.donationQuota).toBe(3);
    });

    it('signGuestSessionToken được gọi với lowercase walletAddress', async () => {
      await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(signGuestSessionToken).toHaveBeenCalledWith({
        sessionId: 'mock-session-id-12345',
        walletAddress: LOWERCASE_ADDRESS
      });
    });

    it('createGuestWalletSession được gọi với status ACTIVE và đầy đủ fields', async () => {
      await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(createGuestWalletSession).toHaveBeenCalledTimes(1);
      expect(createGuestWalletSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'mock-session-id-12345',
          walletAddress: LOWERCASE_ADDRESS,
          status: 'ACTIVE',
          donationCount: 0,
          renewalCount: 0,
          claimedByUserId: null,
          hasPendingDonation: false,
          pendingAlertSentAt: null
        })
      );
    });

    it('ném ApplicationError khi walletAddress không hợp lệ (throw từ ethers.getAddress)', async () => {
      await expect(
        createNewGuestSession(
          'invalid-address',
          mockSessionData.deviceFingerprintHash,
          mockSessionData.ipAddress,
          mockSessionData.userAgent
        )
      ).rejects.toThrow('Địa chỉ ví không hợp lệ.');
    });

    it('ethers v6 normalize lowercase address thành checksum (không throw)', async () => {
      const result = await createNewGuestSession(
        LOWERCASE_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );
      expect(result).toHaveProperty('sessionId');
    });

    it('ném ApplicationError khi fingerprint hash không đúng format SHA-256 (quá ngắn)', async () => {
      await expect(
        createNewGuestSession(
          CHECKSUM_ADDRESS,
          'short-hash',
          mockSessionData.ipAddress,
          mockSessionData.userAgent
        )
      ).rejects.toThrow('Device fingerprint không hợp lệ.');
    });

    it('ném ApplicationError khi fingerprint hash chứa ký tự không phải hex', async () => {
      await expect(
        createNewGuestSession(
          CHECKSUM_ADDRESS,
          'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          mockSessionData.ipAddress,
          mockSessionData.userAgent
        )
      ).rejects.toThrow('Device fingerprint không hợp lệ.');
    });

    it('ném ApplicationError khi fingerprint count >= 3 trong 24h', async () => {
      vi.mocked(countRecentSessionsByFingerprint).mockResolvedValue(3);

      await expect(
        createNewGuestSession(
          CHECKSUM_ADDRESS,
          mockSessionData.deviceFingerprintHash,
          mockSessionData.ipAddress,
          mockSessionData.userAgent
        )
      ).rejects.toThrow('Đã đạt giới hạn tạo phiên');
    });

    it('ném ApplicationError khi IP burst >= 3 sessions trong 1h', async () => {
      vi.mocked(countRecentSessionsByIp).mockResolvedValue(3);

      await expect(
        createNewGuestSession(
          CHECKSUM_ADDRESS,
          mockSessionData.deviceFingerprintHash,
          mockSessionData.ipAddress,
          mockSessionData.userAgent
        )
      ).rejects.toThrow('Phát hiện nhiều phiên từ cùng địa chỉ IP');
    });

    it('kiểm tra fingerprint limit và IP burst song song', async () => {
      await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(countRecentSessionsByFingerprint).toHaveBeenCalled();
      expect(countRecentSessionsByIp).toHaveBeenCalled();
    });

    it('vẫn tạo session thành công khi evaluateAndSaveGuestRisk throw (graceful degradation)', async () => {
      vi.mocked(evaluateAndSaveGuestRisk).mockRejectedValue(new Error('RPC error'));

      const result = await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('guestSessionToken');

      expect(upsertGuestDonationRisk).toHaveBeenCalledWith(
        'mock-session-id-12345',
        expect.objectContaining({
          sessionId: 'mock-session-id-12345',
          riskScore: 0,
          riskLevel: 'SAFE',
          trustMultiplier: 1.0,
          blocked: false
        })
      );
    });

    it('T2: session vẫn được tạo thành công khi cả evaluateAndSaveGuestRisk VÀ upsert đều throw (double-fail)', async () => {
      // evaluateAndSaveGuestRisk throw → fallback upsert cũng throw
      vi.mocked(evaluateAndSaveGuestRisk).mockRejectedValue(new Error('RPC error'));
      vi.mocked(upsertGuestDonationRisk).mockRejectedValue(new Error('DB write failed'));

      // getLogger mock returns error/warn functions that are no-ops
      const result = await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      // Session vẫn được tạo thành công — không throw
      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('guestSessionToken');
      expect(result.sessionId).toBe('mock-session-id-12345');
      // evaluateAndSaveGuestRisk đã được gọi
      expect(evaluateAndSaveGuestRisk).toHaveBeenCalledTimes(1);
      // upsert cũng đã được gọi trong fallback (rồi throw)
      expect(upsertGuestDonationRisk).toHaveBeenCalledTimes(1);
    });

    it('gọi evaluateAndSaveGuestRisk sau khi tạo session', async () => {
      await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(evaluateAndSaveGuestRisk).toHaveBeenCalledTimes(1);
      expect(evaluateAndSaveGuestRisk).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'mock-session-id-12345',
          walletAddress: LOWERCASE_ADDRESS,
          deviceFingerprintHash: mockSessionData.deviceFingerprintHash
        }),
        mockSessionData.ipAddress,
        expect.any(Date)
      );
    });

    it('serverSalt được sinh ngẫu nhiên (64 hex chars)', async () => {
      const result = await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      expect(result.serverSalt).toBeDefined();
      expect(result.serverSalt).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(result.serverSalt)).toBe(true);
    });

    it('expiresAt được set đúng 72 giờ từ thời điểm tạo', async () => {
      const beforeCreate = new Date();
      const result = await createNewGuestSession(
        CHECKSUM_ADDRESS,
        mockSessionData.deviceFingerprintHash,
        mockSessionData.ipAddress,
        mockSessionData.userAgent
      );

      const expiresAt = new Date(result.expiresAt);
      const seventyTwoHoursMs = 72 * 60 * 60 * 1000;

      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime() + seventyTwoHoursMs - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(beforeCreate.getTime() + seventyTwoHoursMs + 5000);
    });
  });

  // -------------------------------------------------------------------------
  // refreshExistingSession
  // -------------------------------------------------------------------------
  describe('refreshExistingSession', () => {
    it('refresh thành công và trả về token mới', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      });

      const result = await refreshExistingSession(
        mockSessionData.sessionId,
        LOWERCASE_ADDRESS
      );

      expect(result).toHaveProperty('guestSessionToken');
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('renewalCount');
      expect(signGuestSessionToken).toHaveBeenCalled();
    });

    it('tăng renewalCount lên 1 khi refresh lần đầu', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        renewalCount: 0,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      });

      const result = await refreshExistingSession(
        mockSessionData.sessionId,
        LOWERCASE_ADDRESS
      );

      expect(result.renewalCount).toBe(1);
      expect(updateGuestWalletSession).toHaveBeenCalledWith(
        mockSessionData.sessionId,
        expect.objectContaining({
          renewalCount: 1,
          expiresAt: expect.any(Date)
        })
      );
    });

    it('signGuestSessionToken được gọi với đúng sessionId và walletAddress', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      });

      await refreshExistingSession(
        mockSessionData.sessionId,
        LOWERCASE_ADDRESS
      );

      expect(signGuestSessionToken).toHaveBeenCalledWith({
        sessionId: mockSessionData.sessionId,
        walletAddress: LOWERCASE_ADDRESS
      });
    });

    it('ném ApplicationError khi session không tồn tại', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      await expect(
        refreshExistingSession(mockSessionData.sessionId, LOWERCASE_ADDRESS)
      ).rejects.toThrow('Guest session không tồn tại');
    });

    it('ném ApplicationError khi walletAddress không khớp', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(mockSessionData);

      await expect(
        refreshExistingSession(mockSessionData.sessionId, '0xdifferent')
      ).rejects.toThrow('Wallet address không khớp với session');
    });

    it('ném ApplicationError khi session status không phải ACTIVE', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        status: 'EXPIRED'
      });

      await expect(
        refreshExistingSession(mockSessionData.sessionId, LOWERCASE_ADDRESS)
      ).rejects.toThrow('Guest session đã hết hạn hoặc bị vô hiệu hóa');
    });

    it('ném ApplicationError khi session đã hết hạn (expiresAt < now)', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        expiresAt: new Date(Date.now() - 1000)
      });

      await expect(
        refreshExistingSession(mockSessionData.sessionId, LOWERCASE_ADDRESS)
      ).rejects.toThrow('Guest session đã hết hạn');
    });

    it('ném ApplicationError khi đã đạt giới hạn refresh (renewalCount >= 5)', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        renewalCount: 5,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      });

      await expect(
        refreshExistingSession(mockSessionData.sessionId, LOWERCASE_ADDRESS)
      ).rejects.toThrow('Đã đạt giới hạn làm mới phiên');
    });
  });

  // -------------------------------------------------------------------------
  // getSessionStatus
  // -------------------------------------------------------------------------
  describe('getSessionStatus', () => {
    it('trả về session status khi tìm thấy', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        donationCount: 1,
        totalDonatedAmount: 5000,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000)
      });

      const result = await getSessionStatus(mockSessionData.sessionId);

      expect(result).toEqual({
        sessionId: mockSessionData.sessionId,
        walletAddress: LOWERCASE_ADDRESS,
        status: 'ACTIVE',
        donationCount: 1,
        totalDonatedAmount: 5000,
        expiresAt: expect.any(String),
        remainingDonations: 2
      });
    });

    it('trả về remainingDonations = 0 khi đã donate đủ 3 lần', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        donationCount: 3,
        totalDonatedAmount: 15000,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000)
      });

      const result = await getSessionStatus(mockSessionData.sessionId);

      expect(result.remainingDonations).toBe(0);
    });

    it('remainingDonations không bao giờ âm (dù donationCount > 3)', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue({
        ...mockSessionData,
        donationCount: 5,
        totalDonatedAmount: 25000,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000)
      });

      const result = await getSessionStatus(mockSessionData.sessionId);

      expect(result.remainingDonations).toBe(0);
    });

    it('ném ApplicationError khi session không tồn tại', async () => {
      vi.mocked(findGuestWalletSessionById).mockResolvedValue(null);

      await expect(
        getSessionStatus(mockSessionData.sessionId)
      ).rejects.toThrow('Guest session không tồn tại');
    });
  });
});
