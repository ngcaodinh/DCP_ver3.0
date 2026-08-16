import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addSybilAuditLog: vi.fn(),
  findUserById: vi.fn(),
  findUserByWalletAddress: vi.fn(),
  updateUser: vi.fn(),
  findDonationsByDonorAddress: vi.fn(),
  recalculateRankingSnapshot: vi.fn(),
  invalidateRankingCache: vi.fn(),
  logEvent: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../models/authModel', () => ({
  addSybilAuditLog: mocks.addSybilAuditLog,
  findUserById: mocks.findUserById,
  findUserByWalletAddress: mocks.findUserByWalletAddress,
  updateUser: mocks.updateUser,
  AuthUserModel: {}
}));
vi.mock('../../models/donationModel', () => ({
  findDonationsByDonorAddress: mocks.findDonationsByDonorAddress
}));
vi.mock('../../services/rankingService', () => ({
  recalculateRankingSnapshot: mocks.recalculateRankingSnapshot
}));
vi.mock('../../services/rankingCacheService', () => ({
  invalidateRankingCache: mocks.invalidateRankingCache
}));
vi.mock('../../services/event-logger.service', () => ({
  logEvent: mocks.logEvent
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import { toggleSybilStatus } from '../../services/sybilService';

const user = {
  id: 'user-1',
  email: 'user@example.com',
  fullName: 'User',
  role: 'donor',
  walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
  smartAccountOwnerAddress: null,
  smartAccountOwnerEncryptedPrivateKey: null,
  socialProvider: 'google',
  socialAccountId: 'social-1',
  isEmailVerified: true,
  accountStatus: 'ACTIVE' as const,
  organizationName: null,
  legalRegistrationNumber: null,
  isSybil: false,
  lastLoginAt: new Date(),
  lastLoginIp: null,
  lastLoginUserAgent: null,
  correlationId: 'corr-1',
  fcmDeviceToken: null,
  phoneNumber: null,
  authVersion: 1
};

describe('sybilService event logger integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user);
    mocks.updateUser.mockResolvedValue(user);
    mocks.addSybilAuditLog.mockResolvedValue(undefined);
    mocks.recalculateRankingSnapshot.mockResolvedValue(undefined);
    mocks.invalidateRankingCache.mockResolvedValue(undefined);
    mocks.findDonationsByDonorAddress.mockResolvedValue([]);
  });

  it('ghi riskScore tính từ donation pattern mà không chặn kết quả toggle', async () => {
    mocks.findDonationsByDonorAddress.mockResolvedValue([
      { correlationId: 'ip:127.0.0.1', blockNumber: 100, amount: 100, timestamp: new Date() },
      { correlationId: 'ip:127.0.0.1', blockNumber: 101, amount: 100, timestamp: new Date() },
      { correlationId: 'ip:127.0.0.1', blockNumber: 102, amount: 100, timestamp: new Date() }
    ]);

    const result = await toggleSybilStatus({
      userId: 'user-1',
      walletAddress: user.walletAddress,
      action: 'mark',
      reason: 'manual review',
      performedBy: 'admin-1',
      performedByRole: 'admin',
      ipAddress: '127.0.0.1',
      userAgent: 'test'
    });
    await vi.waitFor(() => expect(mocks.logEvent).toHaveBeenCalledTimes(1));

    expect(result.success).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SYBIL_FLAGGED',
      walletAddress: user.walletAddress,
      payload: { riskScore: 47, flagReason: 'manual review' }
    }));
  });

  it('donation history lỗi vẫn trả thành công và ghi riskScore null', async () => {
    mocks.findDonationsByDonorAddress.mockRejectedValue(new Error('database unavailable'));

    await expect(toggleSybilStatus({
      userId: 'user-1',
      walletAddress: user.walletAddress,
      action: 'mark',
      reason: 'manual review',
      performedBy: 'admin-1',
      performedByRole: 'admin',
      ipAddress: '127.0.0.1',
      userAgent: 'test'
    })).resolves.toEqual(expect.objectContaining({ success: true }));
    await vi.waitFor(() => expect(mocks.logEvent).toHaveBeenCalledTimes(1));

    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: { riskScore: null, flagReason: 'manual review' }
    }));
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Không lấy được donation history'),
      expect.any(Object)
    );
  });
});
