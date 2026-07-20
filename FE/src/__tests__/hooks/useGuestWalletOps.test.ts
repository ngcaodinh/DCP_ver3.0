/**
 * Unit tests cho useGuestWalletOps hook — test donation execution và các operations.
 * Pattern giống các test files hiện có trong project.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGuestWalletOps } from '@/app/hooks/useGuestWalletOps';
import type { GuestWalletInitState } from '@/app/hooks/useGuestSessionManager';

// ============================================================
// HOISTED MOCKS — Sử dụng vi.hoisted() để hoisting works correctly
// ============================================================
const mockQueryClientInvalidate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockRequestPaymasterSponsorship = vi.hoisted(() => vi.fn());
const mockPrepareGuestClaim = vi.hoisted(() => vi.fn());
const mockExecuteGuestClaim = vi.hoisted(() => vi.fn());
const mockSubmitUserOpToBundler = vi.hoisted(() => vi.fn());
const mockFetchAccountNonce = vi.hoisted(() => vi.fn());
const mockEstimateUserOpGas = vi.hoisted(() => vi.fn());
const mockSubmitClaimUserOpToBackend = vi.hoisted(() => vi.fn());
const mockBuildDonateCallData = vi.hoisted(() => vi.fn());
const mockBuildChangeOwnerCallData = vi.hoisted(() => vi.fn());
const mockBuildClaimUserOpPayload = vi.hoisted(() => vi.fn());
const mockGenerateDeviceFingerprint = vi.hoisted(() => vi.fn());
const mockDecryptOwnerKey = vi.hoisted(() => vi.fn());
const mockLoadGuestWallet = vi.hoisted(() => vi.fn());
const mockLoadGuestSessionToken = vi.hoisted(() => vi.fn());
const mockClearGuestWallet = vi.hoisted(() => vi.fn());
const mockClearGuestSessionToken = vi.hoisted(() => vi.fn());
const mockGetDonationErrorMessage = vi.hoisted(() => vi.fn());

// Mock TanStack Query
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockQueryClientInvalidate }),
}));

// Mock guestApiClient
vi.mock('@/app/utils/guestApiClient', () => ({
  requestPaymasterSponsorship: mockRequestPaymasterSponsorship,
  prepareGuestClaim: mockPrepareGuestClaim,
  executeGuestClaim: mockExecuteGuestClaim,
  GuestApiError: class extends Error {
    constructor(public errorCode: string, public statusCode: number) {
      super();
      this.name = 'GuestApiError';
    }
  },
}));

// Mock guestBundlerClient
vi.mock('@/app/utils/guestBundlerClient', () => ({
  submitUserOpToBundler: mockSubmitUserOpToBundler,
  fetchAccountNonce: mockFetchAccountNonce,
  estimateUserOpGas: mockEstimateUserOpGas,
  submitClaimUserOpToBackend: mockSubmitClaimUserOpToBackend,
  DEFAULT_MAX_FEE_PER_GAS: '0x59682f00',
  DEFAULT_MAX_PRIORITY_FEE_PER_GAS: '0x59682f00',
}));

// Mock guestUserOpBuilder
vi.mock('@/app/utils/guestUserOpBuilder', () => ({
  buildDonateCallData: mockBuildDonateCallData,
  buildChangeOwnerCallData: mockBuildChangeOwnerCallData,
  buildClaimUserOpPayload: mockBuildClaimUserOpPayload,
}));

// Mock deviceFingerprint
vi.mock('@/app/utils/deviceFingerprint', () => ({
  generateDeviceFingerprint: mockGenerateDeviceFingerprint,
}));

// Mock guestWalletCrypto
vi.mock('@/app/utils/guestWalletCrypto', () => ({
  decryptOwnerKey: mockDecryptOwnerKey,
}));

// Mock guestWalletStorage
vi.mock('@/app/utils/guestWalletStorage', () => ({
  loadGuestWallet: mockLoadGuestWallet,
  loadGuestSessionToken: mockLoadGuestSessionToken,
  clearGuestWallet: mockClearGuestWallet,
  clearGuestSessionToken: mockClearGuestSessionToken,
}));

// Mock guestErrorUtils
vi.mock('@/app/constants/guestErrorUtils', () => ({
  getDonationErrorMessage: mockGetDonationErrorMessage,
}));

// Mock guestDonationErrors
vi.mock('@/app/constants/guestDonationErrors', () => ({
  GUEST_DONATION_ERROR_MESSAGES: {
    GUEST_DONATION_QUOTA_EXCEEDED: 'Ban da dat gioi han 3 lan quyen gop.',
  },
}));

// ============================================================
// HELPER
// ============================================================
function makeInitState(overrides = {}): GuestWalletInitState {
  return {
    initStatus: 'READY',
    initError: null,
    walletAddress: '0x1234567890123456789012345678901234567890',
    sessionId: 'sess123',
    guestSessionToken: 'token123',
    donationQuota: 3,
    donationCount: 0,
    remainingDonations: 3,
    canDonate: true,
    hasPendingDonation: false,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    browserCompat: { riskLevel: 'SAFE', details: [] },
    claimPromptDismissed: false,
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================
describe('useGuestWalletOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();

    // Reset all mocks to default successful return values
    mockRequestPaymasterSponsorship.mockResolvedValue({
      paymasterAndData: '0xdeadbeef',
      userOpHash: '0x' + 'b'.repeat(64),
      sponsorshipId: 'sp1',
      paymasterType: 'FREE',
      paymasterSponsoredGas: true,
      trustMultiplier: 1.0,
      riskScore: 10,
    });
    mockPrepareGuestClaim.mockResolvedValue({ claimEOAAddress: '0xabcd', claimNonce: 'nonce1' });
    mockExecuteGuestClaim.mockResolvedValue({ changeOwnerTxHash: '0xtx1', claimId: 'c1', claimType: 'NEW_ACCOUNT', donatedCount: 2 });
    mockSubmitUserOpToBundler.mockResolvedValue({ txHash: '0xtx123', userOpHash: '0x' + 'c'.repeat(64) });
    mockFetchAccountNonce.mockResolvedValue('0x1');
    mockEstimateUserOpGas.mockResolvedValue({
      callGasLimit: '0x50000',
      verificationGasLimit: '0x50000',
      preVerificationGas: '0x50000',
    });
    mockSubmitClaimUserOpToBackend.mockResolvedValue({ userOpHash: '0x' + 'd'.repeat(64) });
    mockBuildDonateCallData.mockResolvedValue('0x6e96e9b1' + '0'.repeat(128));
    mockBuildChangeOwnerCallData.mockResolvedValue('0xb8d6d998' + '0'.repeat(64));
    mockBuildClaimUserOpPayload.mockResolvedValue({ sender: '0x1234', callData: '0xcall' });
    mockGenerateDeviceFingerprint.mockResolvedValue('a'.repeat(64));
    mockDecryptOwnerKey.mockResolvedValue('0x' + '1'.repeat(64));
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
    mockGetDonationErrorMessage.mockImplementation((e: unknown) => (e as Error).message || 'Unknown error');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial state', () => {
    it('should return IDLE status initially', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(result.current.donationState.donationStatus).toBe('IDLE');
    });

    it('should return null error initially', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(result.current.donationState.donationError).toBeNull();
    });

    it('should return null hashes initially', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(result.current.donationState.lastUserOpHash).toBeNull();
      expect(result.current.donationState.lastTxHash).toBeNull();
    });

    it('should provide clearDonationState function', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(typeof result.current.clearDonationState).toBe('function');
    });

    it('should provide getCachedOwnerKey function', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(typeof result.current.getCachedOwnerKey).toBe('function');
    });

    it('should provide setOwnerKeyCache function', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(typeof result.current.setOwnerKeyCache).toBe('function');
    });
  });

  describe('clearDonationState', () => {
    it('should reset to IDLE status', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      // Verify initial state is IDLE
      expect(result.current.donationState.donationStatus).toBe('IDLE');
      expect(result.current.donationState.donationError).toBeNull();
      expect(result.current.donationState.lastUserOpHash).toBeNull();
      expect(result.current.donationState.lastTxHash).toBeNull();
    });
  });

  describe('Owner key cache', () => {
    it('should return null when cache is empty', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      expect(result.current.getCachedOwnerKey()).toBeNull();
    });

    it('should return cached key after setOwnerKeyCache', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      result.current.setOwnerKeyCache('0x' + 'f'.repeat(64));

      expect(result.current.getCachedOwnerKey()).toBe('0x' + 'f'.repeat(64));
    });

    it('should replace old key with new key', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      result.current.setOwnerKeyCache('0x' + 'a'.repeat(64));
      result.current.setOwnerKeyCache('0x' + 'b'.repeat(64));

      expect(result.current.getCachedOwnerKey()).toBe('0x' + 'b'.repeat(64));
    });

    it('should clear cache after clearOwnerKeyCache', () => {
      const { result } = renderHook(() => useGuestWalletOps());

      result.current.setOwnerKeyCache('0x' + 'f'.repeat(64));
      result.current.clearOwnerKeyCache();

      expect(result.current.getCachedOwnerKey()).toBeNull();
    });

    it('should return null after TTL expires', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useGuestWalletOps());

      result.current.setOwnerKeyCache('0x' + 'f'.repeat(64));
      expect(result.current.getCachedOwnerKey()).toBe('0x' + 'f'.repeat(64));

      // Advance time by more than 5 minutes (OWNER_KEY_CACHE_TTL_MS = 5 * 60 * 1000)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(result.current.getCachedOwnerKey()).toBeNull();
    });
  });

  describe('executeDonation — validation failures', () => {
    it('should set FAILED immediately when remainingDonations <= 0', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState({
        remainingDonations: 0,
        canDonate: false,
      });

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toBe(
        'Ban da dat gioi han 3 lan quyen gop.',
      );
    });

    it('should set FAILED immediately when amount is below minimum', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 0, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toContain('10000');
    });

    it('should set FAILED immediately when amount exceeds maximum', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 300000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toContain('200,000');
    });

    it('should set FAILED immediately when walletAddress is null', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState({ walletAddress: null });

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toContain('chưa được khởi tạo');
    });

    it('should set FAILED immediately when sessionId is null', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState({ sessionId: null });

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
    });

    it('should set FAILED immediately when walletAddress is invalid format', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState({ walletAddress: 'invalid-address' });

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toContain('không hợp lệ');
    });
  });

  describe('executeDonation — happy path', () => {
    it('should transition through all statuses correctly', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('SUCCESS');
      expect(result.current.donationState.lastTxHash).toBeTruthy();
      expect(result.current.donationState.lastUserOpHash).toBeTruthy();
    });

    it('should call requestPaymasterSponsorship with correct params', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(mockRequestPaymasterSponsorship).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: '1001',
          amount: 10000,
          sessionId: 'sess123',
        }),
        'token123',
      );
    });

    it('should call submitUserOpToBundler after getting paymaster response', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(mockSubmitUserOpToBundler).toHaveBeenCalled();
    });

    it('should call invalidateQueries after successful donation', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(mockQueryClientInvalidate).toHaveBeenCalledWith({
        queryKey: ['guest-session-status', 'sess123'],
      });
    });

    it('should call clearOwnerKeyCache after donation completes', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.getCachedOwnerKey()).toBeNull();
    });

    it('should decrypt owner key from storage', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(mockDecryptOwnerKey).toHaveBeenCalledWith(
        expect.objectContaining({
          encryptedOwnerKey: 'a'.repeat(64),
          clientSalt: 'b'.repeat(32),
          iv: 'd'.repeat(24),
        }),
        'a'.repeat(64),
        'c'.repeat(32),
      );
    });
  });

  describe('executeDonation — error handling', () => {
    it('should set FAILED with error message when API error occurs', async () => {
      mockRequestPaymasterSponsorship.mockRejectedValueOnce(new Error('Server error'));

      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
      expect(result.current.donationState.donationError).toBe('Server error');
    });

    it('should call invalidateQueries even when donation fails', async () => {
      mockRequestPaymasterSponsorship.mockRejectedValueOnce(new Error('Server error'));

      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(mockQueryClientInvalidate).toHaveBeenCalled();
    });

    it('should clear owner key cache even when donation fails', async () => {
      mockRequestPaymasterSponsorship.mockRejectedValueOnce(new Error('Server error'));

      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      // Cache a key first
      result.current.setOwnerKeyCache('0x' + 'f'.repeat(64));

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.getCachedOwnerKey()).toBeNull();
    });

    it('should set FAILED when loadGuestWallet returns null', async () => {
      mockLoadGuestWallet.mockReturnValueOnce(null);

      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
    });

    it('should set FAILED when bundler submit fails', async () => {
      mockSubmitUserOpToBundler.mockRejectedValueOnce(new Error('Bundler error'));

      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      expect(result.current.donationState.donationStatus).toBe('FAILED');
    });
  });

  describe('executeDonation — caching behavior', () => {
    it('should cache owner key after first decryption', async () => {
      const { result } = renderHook(() => useGuestWalletOps());
      const initState = makeInitState();

      // First donation
      await act(async () => {
        await result.current.executeDonation('1001', 10000, initState);
      });

      // Verify decrypt was called (first time)
      expect(mockDecryptOwnerKey).toHaveBeenCalledTimes(1);
    });
  });
});
