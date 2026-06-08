import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hasGuestWallet,
  loadGuestWallet,
  saveGuestWallet,
  clearGuestWallet,
  isSessionExpired,
  type GuestWalletStorageData,
} from '@/app/utils/guestWalletStorage';

const validStorageData: GuestWalletStorageData = {
  encryptedOwnerKey: 'a'.repeat(64),
  clientSalt: 'b'.repeat(32),
  serverSalt: 'c'.repeat(64),
  iv: 'd'.repeat(24),
  walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
  sessionId: 'session-123',
  expiresAt: '2099-12-31T23:59:59.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  donationQuota: 3,
};

function setupLocalStorageMock() {
  const storage: Record<string, string> = {};
  const mockLocalStorage = {
    getItem: vi.fn((key: string): string | null => storage[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete storage[key];
    }),
  };
  vi.stubGlobal('localStorage', mockLocalStorage);
  return { storage, mockLocalStorage };
}

describe('guestWalletStorage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('hasGuestWallet', () => {
    it('should return true when guest wallet data exists', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.getItem.mockReturnValue('{}');

      expect(hasGuestWallet()).toBe(true);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('dcp_guest_wallet');
    });

    it('should return false when no guest wallet data exists', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.getItem.mockReturnValue(null as unknown as string);

      expect(hasGuestWallet()).toBe(false);
    });

    it('should return false when localStorage throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => {
          throw new Error('storage error');
        }),
      });

      expect(hasGuestWallet()).toBe(false);
    });
  });

  describe('loadGuestWallet', () => {
    it('should return parsed data when valid JSON exists', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(validStorageData));

      const result = loadGuestWallet();

      expect(result).toEqual(validStorageData);
    });

    it('should return null when no data exists', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.getItem.mockReturnValue(null as unknown as string);

      expect(loadGuestWallet()).toBeNull();
    });

    it('should return null when data has corrupted JSON', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      // JSON không hợp lệ — parse thất bại
      // Code không gọi removeItem khi parse lỗi (để tránh mất dữ liệu khi có lỗi tạm thời)
      mockLocalStorage.getItem.mockReturnValue('{ invalid json }' as unknown as string);

      const result = loadGuestWallet();

      expect(result).toBeNull();
      // removeItem không được gọi vì lỗi parse không phải lỗi validation
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should return null and remove data with missing required fields', () => {
      const { storage, mockLocalStorage } = setupLocalStorageMock();
      storage['dcp_guest_wallet'] = JSON.stringify({
        encryptedOwnerKey: 'a',
        // thiếu các trường bắt buộc khác
      });
      mockLocalStorage.getItem.mockImplementation((key: string): string | null => (storage[key] ?? null) as string | null);

      const result = loadGuestWallet();

      expect(result).toBeNull();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('dcp_guest_wallet');
    });

    it('should return null and remove data with non-string fields', () => {
      const { storage, mockLocalStorage } = setupLocalStorageMock();
      storage['dcp_guest_wallet'] = JSON.stringify({
        ...validStorageData,
        walletAddress: 12345,
      });
      mockLocalStorage.getItem.mockImplementation((key: string): string | null => (storage[key] ?? null) as string | null);

      const result = loadGuestWallet();

      expect(result).toBeNull();
    });

    it('should return null when localStorage throws during parse', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.getItem.mockReturnValue('valid json');
      vi.stubGlobal('JSON', {
        parse: vi.fn(() => {
          throw new Error('parse error');
        }),
      });

      const result = loadGuestWallet();

      expect(result).toBeNull();
    });
  });

  describe('saveGuestWallet', () => {
    it('should serialize and store data in localStorage', () => {
      const { storage, mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.setItem.mockImplementation((key: string, value: string) => {
        storage[key] = value;
      });

      saveGuestWallet(validStorageData);

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'dcp_guest_wallet',
        JSON.stringify(validStorageData),
      );
    });

    it('should throw when localStorage throws', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.setItem.mockImplementation(() => {
        throw new Error('quota exceeded');
      });

      expect(() => saveGuestWallet(validStorageData)).toThrow(
        'Không thể lưu dữ liệu guest wallet vào LocalStorage.',
      );
    });
  });

  describe('clearGuestWallet', () => {
    it('should remove guest wallet from localStorage', () => {
      const { mockLocalStorage } = setupLocalStorageMock();

      clearGuestWallet();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('dcp_guest_wallet');
    });

    it('should not throw when localStorage throws', () => {
      const { mockLocalStorage } = setupLocalStorageMock();
      mockLocalStorage.removeItem.mockImplementation(() => {
        throw new Error('error');
      });

      expect(() => clearGuestWallet()).not.toThrow();
    });
  });

  describe('isSessionExpired', () => {
    it('should return false for future expiry date', () => {
      const data: GuestWalletStorageData = {
        ...validStorageData,
        expiresAt: '2099-12-31T23:59:59.000Z',
      };

      expect(isSessionExpired(data)).toBe(false);
    });

    it('should return true for past expiry date', () => {
      const data: GuestWalletStorageData = {
        ...validStorageData,
        expiresAt: '2020-01-01T00:00:00.000Z',
      };

      expect(isSessionExpired(data)).toBe(true);
    });

    it('should return true for invalid expiry date string', () => {
      const data: GuestWalletStorageData = {
        ...validStorageData,
        expiresAt: 'not-a-date',
      };

      expect(isSessionExpired(data)).toBe(true);
    });

    it('should return true for empty expiry date', () => {
      const data: GuestWalletStorageData = {
        ...validStorageData,
        expiresAt: '',
      };

      expect(isSessionExpired(data)).toBe(true);
    });
  });
});
