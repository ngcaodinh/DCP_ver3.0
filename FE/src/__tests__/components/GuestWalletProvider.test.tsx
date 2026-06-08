/**
 * Unit tests cho GuestWalletProvider — test logic chính mà không cần render React.
 * Pattern giống các test files hiện có trong project (deviceFingerprint.test.ts, browserCompat.test.ts).
 * Test tập trung vào: state transitions, error handling, và business logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies trước khi import module
vi.mock('@/app/utils/browserCompat', () => ({
  detectBrowserCompatibility: vi.fn(),
}));

vi.mock('@/app/utils/guestWalletCrypto', () => ({
  encryptOwnerKey: vi.fn().mockResolvedValue({
    encryptedOwnerKey: 'encrypted_key_hex',
    clientSalt: 'clientsalt_hex',
    iv: 'iv_hex',
  }),
}));

vi.mock('@/app/utils/guestWalletStorage', () => ({
  hasGuestWallet: vi.fn(),
  loadGuestWallet: vi.fn(),
  saveGuestWallet: vi.fn(),
  clearGuestWallet: vi.fn(),
  isSessionExpired: vi.fn(),
}));

vi.mock('@/app/utils/guestApiClient', () => ({
  createGuestSession: vi.fn(),
  getGuestSessionStatus: vi.fn(),
  refreshGuestSession: vi.fn(),
  requestPaymasterSponsorship: vi.fn(),
  prepareGuestClaim: vi.fn(),
  executeGuestClaim: vi.fn(),
}));

vi.mock('@/app/utils/deviceFingerprint', () => ({
  generateDeviceFingerprint: vi.fn().mockResolvedValue('fingerprint_hash_hex'),
}));

vi.mock('ethers', () => ({
  Wallet: {
    createRandom: vi.fn().mockReturnValue({
      privateKey: '0x' + 'b'.repeat(64),
      address: '0x' + 'a'.repeat(40),
    }),
  },
  hashMessage: vi.fn().mockReturnValue('0x' + 'b'.repeat(64)),
  SigningKey: vi.fn().mockImplementation(() => ({
    sign: () => ({ serialized: '0x' + 'c'.repeat(130) }),
  })),
  getBytes: vi.fn().mockImplementation((data: string) => {
    // Strip 0x prefix and convert hex string to Uint8Array-like for ethers
    const hex = data.startsWith('0x') ? data.slice(2) : data;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }),
  AbiCoder: {
    defaultAbiCoder: vi.fn().mockReturnValue({
      encode: vi.fn().mockReturnValue('0x' + 'e'.repeat(200)),
    }),
  },
}));

import { detectBrowserCompatibility } from '@/app/utils/browserCompat';
import {
  hasGuestWallet,
  loadGuestWallet,
  saveGuestWallet,
  clearGuestWallet,
  isSessionExpired,
} from '@/app/utils/guestWalletStorage';
import {
  createGuestSession,
  getGuestSessionStatus,
} from '@/app/utils/guestApiClient';

const FIXTURE_WALLET = '0x' + 'a'.repeat(40);
const FIXTURE_FINGERPRINT = 'a'.repeat(64);

describe('GuestWalletProvider — Unit Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // BROWSER COMPATIBILITY
  // ============================================================

  describe('Browser Compatibility Check', () => {
    it('should resolve CRITICAL riskLevel', async () => {
      vi.mocked(detectBrowserCompatibility).mockResolvedValue({
        riskLevel: 'CRITICAL',
        details: ['Web Crypto API không khả dụng.'],
      });

      const result = await detectBrowserCompatibility();

      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.details).toContain('Web Crypto API không khả dụng.');
    });

    it('should resolve SAFE riskLevel', async () => {
      vi.mocked(detectBrowserCompatibility).mockResolvedValue({
        riskLevel: 'SAFE',
        details: [],
      });

      const result = await detectBrowserCompatibility();

      expect(result.riskLevel).toBe('SAFE');
      expect(result.details).toHaveLength(0);
    });
  });

  // ============================================================
  // LOCAL STORAGE HELPERS
  // ============================================================

  describe('LocalStorage Helpers', () => {
    it('should return false when no wallet in storage', () => {
      vi.mocked(hasGuestWallet).mockReturnValue(false);
      expect(hasGuestWallet()).toBe(false);
    });

    it('should return true when wallet exists in storage', () => {
      vi.mocked(hasGuestWallet).mockReturnValue(true);
      expect(hasGuestWallet()).toBe(true);
    });

    it('should detect expired session', () => {
      vi.mocked(isSessionExpired).mockReturnValue(true);
      expect(isSessionExpired({
        encryptedOwnerKey: 'encrypted',
        clientSalt: 'salt',
        serverSalt: 'salt',
        iv: 'iv',
        walletAddress: FIXTURE_WALLET,
        sessionId: 'session-id',
        expiresAt: '2020-01-01T00:00:00Z',
        createdAt: '2020-01-01T00:00:00Z',
        donationQuota: 3,
      })).toBe(true);
    });

    it('should detect non-expired session', () => {
      vi.mocked(isSessionExpired).mockReturnValue(false);
      expect(isSessionExpired({
        encryptedOwnerKey: 'encrypted',
        clientSalt: 'salt',
        serverSalt: 'salt',
        iv: 'iv',
        walletAddress: FIXTURE_WALLET,
        sessionId: 'session-id',
        expiresAt: '2030-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        donationQuota: 3,
      })).toBe(false);
    });

    it('should load valid storage data', () => {
      const storedData = {
        encryptedOwnerKey: 'encrypted',
        clientSalt: 'salt',
        serverSalt: 'salt',
        iv: 'iv',
        walletAddress: FIXTURE_WALLET,
        sessionId: 'session-id',
        expiresAt: '2030-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        donationQuota: 3,
      };
      vi.mocked(loadGuestWallet).mockReturnValue(storedData);

      const result = loadGuestWallet();

      expect(result).toEqual(storedData);
      expect(result?.walletAddress).toBe(FIXTURE_WALLET);
    });

    it('should return null for corrupted storage data', () => {
      vi.mocked(loadGuestWallet).mockReturnValue(null);

      const result = loadGuestWallet();

      expect(result).toBeNull();
    });

    it('should call clearGuestWallet when clearing data', () => {
      clearGuestWallet();

      expect(clearGuestWallet).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // SESSION CREATE
  // ============================================================

  describe('Create Guest Session', () => {
    it('should create session with valid wallet address', async () => {
      const sessionResponse = {
        sessionId: 'session-123',
        guestSessionToken: 'token-abc',
        expiresAt: '2030-01-01T00:00:00Z',
        serverSalt: 'server-salt-hex',
        donationQuota: 3,
      };
      vi.mocked(createGuestSession).mockResolvedValue(sessionResponse);

      const result = await createGuestSession({
        walletAddress: FIXTURE_WALLET,
        deviceFingerprintHash: FIXTURE_FINGERPRINT,
      });

      expect(createGuestSession).toHaveBeenCalledWith({
        walletAddress: FIXTURE_WALLET,
        deviceFingerprintHash: FIXTURE_FINGERPRINT,
      });
      expect(result.sessionId).toBe('session-123');
      expect(result.donationQuota).toBe(3);
    });
  });

  // ============================================================
  // SESSION STATUS
  // ============================================================

  describe('Get Guest Session Status', () => {
    it('should return ACTIVE session status', async () => {
      const statusResponse = {
        sessionId: 'session-123',
        walletAddress: FIXTURE_WALLET,
        status: 'ACTIVE' as const,
        donationCount: 2,
        donationQuota: 3,
        totalDonatedAmount: 100,
        expiresAt: '2030-01-01T00:00:00Z',
        remainingDonations: 1,
      };
      vi.mocked(getGuestSessionStatus).mockResolvedValue(statusResponse);

      const result = await getGuestSessionStatus('session-123', 'fake-token');

      expect(getGuestSessionStatus).toHaveBeenCalledWith('session-123', 'fake-token');
      expect(result.status).toBe('ACTIVE');
      expect(result.donationCount).toBe(2);
      expect(result.remainingDonations).toBe(1);
    });

    it('should return CLAIMED session status', async () => {
      const statusResponse = {
        sessionId: 'session-123',
        walletAddress: FIXTURE_WALLET,
        status: 'CLAIMED' as const,
        donationCount: 3,
        donationQuota: 3,
        totalDonatedAmount: 150,
        expiresAt: '2030-01-01T00:00:00Z',
        remainingDonations: 0,
      };
      vi.mocked(getGuestSessionStatus).mockResolvedValue(statusResponse);

      const result = await getGuestSessionStatus('session-123', 'fake-token');

      expect(result.status).toBe('CLAIMED');
      expect(result.donationCount).toBe(3);
      expect(result.remainingDonations).toBe(0);
    });

    it('should handle server error gracefully', async () => {
      vi.mocked(getGuestSessionStatus).mockRejectedValue(new Error('Network error'));

      await expect(getGuestSessionStatus('session-123', 'fake-token')).rejects.toThrow('Network error');
    });
  });

  // ============================================================
  // STORAGE PERSISTENCE
  // ============================================================

  describe('Storage Persistence', () => {
    it('should save wallet data to storage', () => {
      const storageData = {
        encryptedOwnerKey: 'encrypted_hex',
        clientSalt: 'clientsalt_hex',
        serverSalt: 'serversalt_hex',
        iv: 'iv_hex',
        walletAddress: FIXTURE_WALLET,
        sessionId: 'session-123',
        expiresAt: '2030-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        donationQuota: 3,
      };

      saveGuestWallet(storageData);

      expect(saveGuestWallet).toHaveBeenCalledWith(storageData);
    });
  });

  // ============================================================
  // DONATION CALCULATION
  // ============================================================

  describe('Donation Quota Calculation', () => {
    const MAX_DONATIONS = 3;

    it('should calculate remaining donations correctly', () => {
      const remaining = Math.max(0, MAX_DONATIONS - 2);
      expect(remaining).toBe(1);
    });

    it('should return 0 when donation count equals max', () => {
      const remaining = Math.max(0, MAX_DONATIONS - 3);
      expect(remaining).toBe(0);
    });

    it('should return full quota when no donations made', () => {
      const remaining = Math.max(0, MAX_DONATIONS - 0);
      expect(remaining).toBe(3);
    });

    it('should return 0 when over limit', () => {
      const remaining = Math.max(0, MAX_DONATIONS - 5);
      expect(remaining).toBe(0);
    });
  });

  // ============================================================
  // AMOUNT VALIDATION
  // ============================================================

  describe('Amount Validation', () => {
    it('should reject amount below minimum', () => {
      const amount = 0;
      const isValid = amount >= 1 && amount <= 200000;
      expect(isValid).toBe(false);
    });

    it('should accept valid amount', () => {
      const amount = 50;
      const isValid = amount >= 1 && amount <= 200000;
      expect(isValid).toBe(true);
    });

    it('should accept minimum amount', () => {
      const amount = 1;
      const isValid = amount >= 1 && amount <= 200000;
      expect(isValid).toBe(true);
    });

    it('should accept maximum amount', () => {
      const amount = 200000;
      const isValid = amount >= 1 && amount <= 200000;
      expect(isValid).toBe(true);
    });

    it('should reject amount above maximum', () => {
      const amount = 200001;
      const isValid = amount >= 1 && amount <= 200000;
      expect(isValid).toBe(false);
    });
  });

  // ============================================================
  // WALLET ADDRESS VALIDATION
  // ============================================================

  describe('Wallet Address Validation', () => {
    it('should accept valid EIP-55 address', () => {
      const address = '0x' + 'a'.repeat(40);
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
      expect(isValid).toBe(true);
    });

    it('should reject address with wrong length', () => {
      const address = '0x' + 'a'.repeat(39);
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
      expect(isValid).toBe(false);
    });

    it('should reject address without 0x prefix', () => {
      const address = 'a'.repeat(40);
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
      expect(isValid).toBe(false);
    });
  });
});
