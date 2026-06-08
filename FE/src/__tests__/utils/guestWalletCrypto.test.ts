import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encryptOwnerKey,
  decryptOwnerKey,
  generateClientSalt,
} from '@/app/utils/guestWalletCrypto';

/**
 * Test strategy: Dùng REAL crypto.subtle API của jsdom/Node.
 * Chỉ mock crypto.getRandomValues khi cần deterministic input (IV/salt cố định).
 * Việc này đảm bảo tests kiểm tra toán học AES-GCM + PBKDF2 thực tế,
 * không phải chỉ verify mock calls.
 *
 * Trick: dùng vi.spyOn thay vi stubGlobal để chỉ override getRandomValues,
 * giữ nguyên crypto.subtle từ môi trường thật.
 */

const FIXTURE_FINGERPRINT = 'a'.repeat(64);
const FIXTURE_SERVER_SALT = 'b'.repeat(64);
const FIXTURE_OWNER_KEY = 'c'.repeat(64);

/**
 * Spy on getRandomValues, chỉ override phần cần thiết.
 * Cast qua unknown để tránh lỗi type với generic overload của vi.spyOn.
 */
function mockGetRandomValues(values: number[]) {
  let idx = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(
    ((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = values[idx++ % values.length] as number;
      }
      return arr;
    }) as unknown as typeof crypto.getRandomValues,
  );
}

describe('guestWalletCrypto', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('generateClientSalt', () => {
    it('should return a 32-character hex string (16 bytes)', () => {
      const salt = generateClientSalt();

      expect(salt).toHaveLength(32);
      expect(salt).toMatch(/^[a-f0-9]+$/);
    });

    it('should return different salts on successive calls', () => {
      const salt1 = generateClientSalt();
      const salt2 = generateClientSalt();
      const salt3 = generateClientSalt();

      expect(salt1).not.toBe(salt2);
      expect(salt2).not.toBe(salt3);
    });
  });

  describe('encryptOwnerKey + decryptOwnerKey — real AES-256-GCM roundtrip', () => {
    it('should encrypt and decrypt owner key correctly', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );

      expect(encrypted.encryptedOwnerKey).toMatch(/^[a-f0-9]+$/);
      expect(encrypted.clientSalt).toHaveLength(32);
      expect(encrypted.iv).toHaveLength(24);

      const decrypted = await decryptOwnerKey(
        encrypted,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      expect(decrypted).toBe(FIXTURE_OWNER_KEY);
    });

    it('should produce different ciphertext each call (random IV)', async () => {
      const encrypted1 = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const encrypted2 = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );

      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.encryptedOwnerKey).not.toBe(encrypted2.encryptedOwnerKey);

      const decrypted1 = await decryptOwnerKey(encrypted1, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT);
      const decrypted2 = await decryptOwnerKey(encrypted2, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT);
      expect(decrypted1).toBe(FIXTURE_OWNER_KEY);
      expect(decrypted2).toBe(FIXTURE_OWNER_KEY);
    });

    it('should encrypt arbitrary 64-char hex string owner key', async () => {
      const ownerKey = 'deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234';
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));

      const encrypted = await encryptOwnerKey(ownerKey, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT);
      const decrypted = await decryptOwnerKey(encrypted, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT);

      expect(decrypted).toBe(ownerKey);
    });
  });

  describe('decryptOwnerKey — error handling với real Web Crypto', () => {
    it('should throw when decrypt with wrong device fingerprint', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const wrongFingerprint = '0'.repeat(64);

      await expect(
        decryptOwnerKey(encrypted, wrongFingerprint, FIXTURE_SERVER_SALT),
      ).rejects.toThrow('Giải mã thất bại');
    });

    it('should throw when decrypt with wrong server salt', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const wrongServerSalt = 'f'.repeat(64);

      await expect(
        decryptOwnerKey(encrypted, FIXTURE_FINGERPRINT, wrongServerSalt),
      ).rejects.toThrow('Giải mã thất bại');
    });

    it('should throw when encrypted data is corrupted', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const corrupted = {
        ...encrypted,
        encryptedOwnerKey: encrypted.encryptedOwnerKey.replace(/^./, 'f'),
      };

      await expect(
        decryptOwnerKey(corrupted, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT),
      ).rejects.toThrow();
    });

    it('should throw when IV is tampered', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const tamperedIv = encrypted.iv.replace(/../, 'ff');

      await expect(
        decryptOwnerKey({ ...encrypted, iv: tamperedIv }, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT),
      ).rejects.toThrow();
    });
  });

  describe('trust boundary — fingerprint sensitivity', () => {
    it('should fail decryption when fingerprint differs by one character', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      const nearMatchFingerprint = '0' + FIXTURE_FINGERPRINT.slice(1);

      await expect(
        decryptOwnerKey(encrypted, nearMatchFingerprint, FIXTURE_SERVER_SALT),
      ).rejects.toThrow();
    });
  });

  describe('AES-GCM + PBKDF2 parameter validation', () => {
    it('should produce 12-byte IV (96-bit per NIST recommendation)', async () => {
      mockGetRandomValues(Array.from({ length: 32 }, (_, i) => i + 1));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );

      expect(encrypted.iv).toHaveLength(24);
    });

    it('should produce 16-byte client salt for PBKDF2', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );

      expect(encrypted.clientSalt).toHaveLength(32);
    });

    it('should use AES-GCM authenticated encryption (tamper detection)', async () => {
      mockGetRandomValues(Array.from({ length: 64 }, (_, i) => i));

      const encrypted = await encryptOwnerKey(
        FIXTURE_OWNER_KEY,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );

      const decrypted = await decryptOwnerKey(
        encrypted,
        FIXTURE_FINGERPRINT,
        FIXTURE_SERVER_SALT,
      );
      expect(decrypted).toBe(FIXTURE_OWNER_KEY);

      const tampered = {
        ...encrypted,
        encryptedOwnerKey: encrypted.encryptedOwnerKey.slice(0, 10) + 'z' + encrypted.encryptedOwnerKey.slice(11),
      };

      await expect(
        decryptOwnerKey(tampered, FIXTURE_FINGERPRINT, FIXTURE_SERVER_SALT),
      ).rejects.toThrow();
    });
  });
});
