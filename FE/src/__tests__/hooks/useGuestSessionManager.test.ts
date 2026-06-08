/**
 * Unit tests cho useGuestSessionManager hook — test session lifecycle và các public methods.
 * Pattern giống các test files hiện có trong project.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGuestSessionManager } from '@/app/hooks/useGuestSessionManager';

// ============================================================
// HOISTED MOCKS — Sử dụng vi.hoisted() để hoisting works correctly
// ============================================================
const mockDetectBrowserCompatibility = vi.hoisted(() => vi.fn());
const mockHasGuestWallet = vi.hoisted(() => vi.fn());
const mockLoadGuestWallet = vi.hoisted(() => vi.fn());
const mockSaveGuestWallet = vi.hoisted(() => vi.fn());
const mockLoadGuestSessionToken = vi.hoisted(() => vi.fn());
const mockSaveGuestSessionToken = vi.hoisted(() => vi.fn());
const mockClearGuestWallet = vi.hoisted(() => vi.fn());
const mockClearGuestSessionToken = vi.hoisted(() => vi.fn());
const mockIsSessionExpired = vi.hoisted(() => vi.fn());
const mockCreateGuestSession = vi.hoisted(() => vi.fn());
const mockGetGuestSessionStatus = vi.hoisted(() => vi.fn());
const mockRefreshGuestSession = vi.hoisted(() => vi.fn());
const mockGenerateDeviceFingerprint = vi.hoisted(() => vi.fn());
const mockEncryptOwnerKey = vi.hoisted(() => vi.fn());
const mockGetDonationErrorMessage = vi.hoisted(() => vi.fn());

// Mock modules
vi.mock('@/app/utils/browserCompat', () => ({
  detectBrowserCompatibility: mockDetectBrowserCompatibility,
}));

vi.mock('@/app/utils/guestWalletStorage', () => ({
  hasGuestWallet: mockHasGuestWallet,
  loadGuestWallet: mockLoadGuestWallet,
  saveGuestWallet: mockSaveGuestWallet,
  loadGuestSessionToken: mockLoadGuestSessionToken,
  saveGuestSessionToken: mockSaveGuestSessionToken,
  clearGuestWallet: mockClearGuestWallet,
  clearGuestSessionToken: mockClearGuestSessionToken,
  isSessionExpired: mockIsSessionExpired,
}));

vi.mock('@/app/utils/guestApiClient', () => ({
  createGuestSession: mockCreateGuestSession,
  getGuestSessionStatus: mockGetGuestSessionStatus,
  refreshGuestSession: mockRefreshGuestSession,
  GuestApiError: class extends Error {
    constructor(public errorCode: string, public statusCode: number) {
      super();
      this.name = 'GuestApiError';
    }
  },
}));

vi.mock('@/app/utils/deviceFingerprint', () => ({
  generateDeviceFingerprint: mockGenerateDeviceFingerprint,
}));

vi.mock('@/app/utils/guestWalletCrypto', () => ({
  encryptOwnerKey: mockEncryptOwnerKey,
}));

vi.mock('@/app/constants/guestErrorUtils', () => ({
  getDonationErrorMessage: mockGetDonationErrorMessage,
}));

vi.mock('ethers', () => ({
  Wallet: {
    createRandom: () => ({
      privateKey: '0x' + '1'.repeat(64),
      address: '0x1234567890123456789012345678901234567890',
    }),
  },
}));

// ============================================================
// TESTS
// ============================================================
describe('useGuestSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();

    // Reset all mocks to default safe return values
    mockDetectBrowserCompatibility.mockResolvedValue({ riskLevel: 'SAFE', details: [] });
    mockHasGuestWallet.mockReturnValue(false);
    mockLoadGuestWallet.mockReturnValue(null);
    mockLoadGuestSessionToken.mockReturnValue(null);
    mockIsSessionExpired.mockReturnValue(false);
    mockCreateGuestSession.mockResolvedValue({
      sessionId: 'sess123',
      guestSessionToken: 'token',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      serverSalt: 'salt',
      donationQuota: 3,
    });
    mockGetGuestSessionStatus.mockResolvedValue({
      sessionId: 'sess123',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 0,
      totalDonatedAmount: 0,
      donationQuota: 3,
      remainingDonations: 3,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    mockRefreshGuestSession.mockResolvedValue({
      guestSessionToken: 'newtoken',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      renewalCount: 1,
    });
    mockGenerateDeviceFingerprint.mockResolvedValue('a'.repeat(64));
    mockEncryptOwnerKey.mockResolvedValue({ encryptedOwnerKey: 'deadbeef', clientSalt: 'c1', iv: 'i1' });
    mockGetDonationErrorMessage.mockImplementation((e: unknown) => (e as Error).message || 'Unknown error');
  });

  describe('Initial state', () => {
    it('should return correct default state', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      expect(result.current.initState.initStatus).toBe('IDLE');
      expect(result.current.initState.initError).toBeNull();
      expect(result.current.initState.walletAddress).toBeNull();
      expect(result.current.initState.sessionId).toBeNull();
      expect(result.current.initState.guestSessionToken).toBeNull();
      expect(result.current.initState.donationQuota).toBe(3);
      expect(result.current.initState.donationCount).toBe(0);
      expect(result.current.initState.remainingDonations).toBe(3);
      expect(result.current.initState.canDonate).toBe(false);
      expect(result.current.initState.hasPendingDonation).toBe(false);
      expect(result.current.initState.expiresAt).toBeNull();
      expect(result.current.initState.browserCompat).toBeNull();
      expect(result.current.initState.claimPromptDismissed).toBe(false);
    });

    it('should provide updateInitState function', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      expect(typeof result.current.updateInitState).toBe('function');
    });
  });

  describe('bootstrapGuestWallet', () => {
    it('should set initStatus to READY on success', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(result.current.initState.initStatus).toBe('READY');
      expect(result.current.initState.walletAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(result.current.initState.sessionId).toBe('sess123');
      expect(result.current.initState.guestSessionToken).toBe('token');
      expect(result.current.initState.donationQuota).toBe(3);
      expect(result.current.initState.remainingDonations).toBe(3);
      expect(result.current.initState.canDonate).toBe(true);
    });

    it('should call createGuestSession with correct params', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(mockCreateGuestSession).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: '0x1234567890123456789012345678901234567890',
          deviceFingerprintHash: 'a'.repeat(64),
        }),
      );
    });

    it('should call saveGuestWallet after successful bootstrap', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(mockSaveGuestWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: '0x1234567890123456789012345678901234567890',
          sessionId: 'sess123',
        }),
      );
    });

    it('should call saveGuestSessionToken after successful bootstrap', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(mockSaveGuestSessionToken).toHaveBeenCalledWith(
        'token',
        expect.any(String),
      );
    });

    it('should set initStatus to ERROR when API fails', async () => {
      mockCreateGuestSession.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(result.current.initState.initStatus).toBe('ERROR');
      expect(result.current.initState.initError).toBeTruthy();
    });

    it('should set initStatus to BROWSER_INCOMPATIBLE when browser check fails', async () => {
      mockDetectBrowserCompatibility.mockResolvedValueOnce({
        riskLevel: 'CRITICAL',
        details: ['WebCrypto not available'],
      });

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      expect(result.current.initState.initStatus).toBe('BROWSER_INCOMPATIBLE');
    });
  });

  describe('restoreGuestSession', () => {
    it('should set READY when localStorage has valid data and session is active', async () => {
      mockHasGuestWallet.mockReturnValue(true);
      mockLoadGuestWallet.mockReturnValue({
        encryptedOwnerKey: 'a'.repeat(64),
        clientSalt: 'b'.repeat(32),
        serverSalt: 'c'.repeat(32),
        iv: 'd'.repeat(24),
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionId: 'sess123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        donationQuota: 3,
      });
      mockLoadGuestSessionToken.mockReturnValue({
        token: 'token123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.restoreGuestSession();
      });

      expect(result.current.initState.initStatus).toBe('READY');
      expect(result.current.initState.walletAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(mockGetGuestSessionStatus).toHaveBeenCalledWith('sess123', 'token123');
    });

    it('should trigger BOOTSTRAPPING_NEW when localStorage is empty', async () => {
      mockHasGuestWallet.mockReturnValue(false);
      mockLoadGuestWallet.mockReturnValue(null);

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.restoreGuestSession();
      });

      expect(result.current.initState.initStatus).toBe('BOOTSTRAPPING_NEW');
    });

    it('should trigger BOOTSTRAPPING_NEW when stored data is expired', async () => {
      mockHasGuestWallet.mockReturnValue(true);
      mockLoadGuestWallet.mockReturnValue({
        encryptedOwnerKey: 'a'.repeat(64),
        clientSalt: 'b'.repeat(32),
        serverSalt: 'c'.repeat(32),
        iv: 'd'.repeat(24),
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionId: 'sess123',
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        donationQuota: 3,
      });
      mockIsSessionExpired.mockReturnValue(true);

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.restoreGuestSession();
      });

      expect(mockClearGuestWallet).toHaveBeenCalled();
      expect(result.current.initState.initStatus).toBe('BOOTSTRAPPING_NEW');
    });

    it('should fall back to localStorage data when server is unreachable', async () => {
      mockHasGuestWallet.mockReturnValue(true);
      mockLoadGuestWallet.mockReturnValue({
        encryptedOwnerKey: 'a'.repeat(64),
        clientSalt: 'b'.repeat(32),
        serverSalt: 'c'.repeat(32),
        iv: 'd'.repeat(24),
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionId: 'sess123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        donationQuota: 3,
      });
      mockLoadGuestSessionToken.mockReturnValue({
        token: 'token123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      mockGetGuestSessionStatus.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.restoreGuestSession();
      });

      expect(result.current.initState.initStatus).toBe('READY');
      expect(result.current.initState.walletAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(result.current.initState.remainingDonations).toBe(3);
    });

    it('should set CLAIMED when server returns CLAIMED status', async () => {
      mockHasGuestWallet.mockReturnValue(true);
      mockLoadGuestWallet.mockReturnValue({
        encryptedOwnerKey: 'a'.repeat(64),
        clientSalt: 'b'.repeat(32),
        serverSalt: 'c'.repeat(32),
        iv: 'd'.repeat(24),
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionId: 'sess123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        donationQuota: 3,
      });
      mockLoadGuestSessionToken.mockReturnValue({
        token: 'token123',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      mockGetGuestSessionStatus.mockResolvedValueOnce({
        sessionId: 'sess123',
        walletAddress: '0x1234567890123456789012345678901234567890',
        status: 'CLAIMED',
        donationCount: 3,
        totalDonatedAmount: 150,
        donationQuota: 3,
        remainingDonations: 0,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const { result } = renderHook(() => useGuestSessionManager());

      await act(async () => {
        await result.current.restoreGuestSession();
      });

      expect(mockClearGuestWallet).toHaveBeenCalled();
      expect(mockClearGuestSessionToken).toHaveBeenCalled();
      expect(result.current.initState.initStatus).toBe('CLAIMED');
    });
  });

  describe('refreshGuestSession', () => {
    it('should update token and expiresAt on success', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      // First bootstrap to get valid session
      await act(async () => {
        await result.current.bootstrapGuestWallet();
      });

      // Then refresh
      mockRefreshGuestSession.mockResolvedValueOnce({
        guestSessionToken: 'newtoken123',
        expiresAt: new Date(Date.now() + 86400000 * 2).toISOString(),
        renewalCount: 1,
      });

      await act(async () => {
        await result.current.refreshGuestSession();
      });

      expect(mockSaveGuestSessionToken).toHaveBeenLastCalledWith(
        'newtoken123',
        expect.any(String),
      );
    });

    it('should throw when sessionId is null', async () => {
      const { result } = renderHook(() => useGuestSessionManager());

      await expect(
        act(async () => {
          await result.current.refreshGuestSession();
        }),
      ).rejects.toThrow();
    });
  });

  describe('dismissClaimPrompt', () => {
    it('should set claimPromptDismissed to true', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.dismissClaimPrompt();
      });

      expect(result.current.initState.claimPromptDismissed).toBe(true);
    });

    it('should be callable multiple times', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.dismissClaimPrompt();
        result.current.dismissClaimPrompt();
      });

      expect(result.current.initState.claimPromptDismissed).toBe(true);
    });
  });

  describe('clearGuestWalletData', () => {
    it('should reset to initial state', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      // First set some state
      act(() => {
        result.current.dismissClaimPrompt();
      });

      // Then clear
      act(() => {
        result.current.clearGuestWalletData();
      });

      expect(mockClearGuestWallet).toHaveBeenCalled();
      expect(mockClearGuestSessionToken).toHaveBeenCalled();
      expect(result.current.initState.initStatus).toBe('IDLE');
      expect(result.current.initState.walletAddress).toBeNull();
      expect(result.current.initState.sessionId).toBeNull();
      expect(result.current.initState.guestSessionToken).toBeNull();
      expect(result.current.initState.donationCount).toBe(0);
      expect(result.current.initState.remainingDonations).toBe(3);
      expect(result.current.initState.claimPromptDismissed).toBe(false);
    });
  });

  describe('syncPollResults', () => {
    it('should update donationCount and remainingDonations correctly', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.syncPollResults({
          donationCount: 2,
          remainingDonations: 1,
          donationQuota: 3,
        });
      });

      expect(result.current.initState.donationCount).toBe(2);
      expect(result.current.initState.remainingDonations).toBe(1);
      expect(result.current.initState.canDonate).toBe(true);
    });

    it('should update hasPendingDonation flag when provided', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.syncPollResults({
          donationCount: 1,
          remainingDonations: 2,
          donationQuota: 3,
          hasPendingDonation: true,
        });
      });

      expect(result.current.initState.hasPendingDonation).toBe(true);
    });

    it('should set hasPendingDonation to false when not provided', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.syncPollResults({
          donationCount: 1,
          remainingDonations: 2,
          donationQuota: 3,
        });
      });

      expect(result.current.initState.hasPendingDonation).toBe(false);
    });

    it('should set canDonate to false when donationCount equals quota', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.syncPollResults({
          donationCount: 3,
          remainingDonations: 0,
          donationQuota: 3,
        });
      });

      expect(result.current.initState.canDonate).toBe(false);
    });

    it('should update multiple times correctly', () => {
      const { result } = renderHook(() => useGuestSessionManager());

      act(() => {
        result.current.syncPollResults({
          donationCount: 1,
          remainingDonations: 2,
          donationQuota: 3,
        });
      });

      act(() => {
        result.current.syncPollResults({
          donationCount: 2,
          remainingDonations: 1,
          donationQuota: 3,
        });
      });

      expect(result.current.initState.donationCount).toBe(2);
      expect(result.current.initState.remainingDonations).toBe(1);
    });
  });
});
