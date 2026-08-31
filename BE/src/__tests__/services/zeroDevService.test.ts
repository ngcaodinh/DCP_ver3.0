import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock process.env trước khi import module
const mockEncryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

vi.stubEnv('SMART_ACCOUNT_ENCRYPTION_KEY', mockEncryptionKey);

// Mock tất cả dependencies của zeroDevService - path phải khớp với import trong zeroDevService.ts
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicKey: '0x1234'
  }))
}));

vi.mock('viem/chains', () => ({
  polygonAmoy: { id: 80002, name: 'Polygon Amoy' }
}));

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({})),
  http: vi.fn(() => ({}))
}));

vi.mock('@zerodev/sdk', () => ({
  createKernelAccount: vi.fn(),
  createKernelAccountClient: vi.fn(),
  createZeroDevPaymasterClient: vi.fn()
}));

vi.mock('../../config/zeroDev', () => ({
  getZeroDevConfig: vi.fn(() => ({
    projectId: 'test-project-id',
    rpcUrl: 'https://rpc.test',
    bundlerUrl: 'https://bundler.test',
    paymasterUrl: 'https://paymaster.test',
    entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
  }))
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }))
}));

// Import các function cần test sau khi mock
import { createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk';
import {
  createKernelClientFromEncryptedOwnerKey,
  decryptOwnerPrivateKey,
  encryptOwnerPrivateKey
} from '../../services/zeroDevService';

describe('zeroDevService - encrypt/decrypt Owner Private Key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gắn public client, chain và fee estimator khi dựng Kernel client có Paymaster', async () => {
    vi.mocked(createZeroDevPaymasterClient).mockReturnValue({} as never);
    const encryptedOwnerPrivateKey = encryptOwnerPrivateKey(
      '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    );

    await createKernelClientFromEncryptedOwnerKey(encryptedOwnerPrivateKey);

    expect(createZeroDevPaymasterClient).toHaveBeenCalledWith(expect.objectContaining({
      chain: expect.objectContaining({ id: 80002 })
    }));
    expect(createKernelAccountClient).toHaveBeenCalledWith(expect.objectContaining({
      chain: expect.objectContaining({ id: 80002 }),
      client: expect.any(Object),
      paymaster: expect.anything(),
      userOperation: expect.objectContaining({ estimateFeesPerGas: expect.any(Function) })
    }));
  });

  describe('encryptOwnerPrivateKey', () => {
    it('mã hóa private key thành công và trả về định dạng iv:encrypted:authTag', () => {
      const privateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const encrypted = encryptOwnerPrivateKey(privateKey);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');

      // Kiểm tra định dạng: iv:encrypted:authTag (3 phần, ngăn cách bằng :)
      const parts = encrypted.split(':');
      expect(parts.length).toBe(3);

      // Mỗi phần phải là hex string
      parts.forEach((part: string) => {
        expect(part).toMatch(/^[0-9a-f]+$/i);
      });
    });

    it('cùng private key tạo ra encrypted khác nhau (do IV ngẫu nhiên)', () => {
      const privateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const encrypted1 = encryptOwnerPrivateKey(privateKey);
      const encrypted2 = encryptOwnerPrivateKey(privateKey);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('private key khác nhau tạo ra encrypted khác nhau', () => {
      const privateKey1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const privateKey2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

      const encrypted1 = encryptOwnerPrivateKey(privateKey1);
      const encrypted2 = encryptOwnerPrivateKey(privateKey2);

      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe('decryptOwnerPrivateKey', () => {
    it('giải mã encrypted key thành công và khớp với original', () => {
      const originalKey = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const encrypted = encryptOwnerPrivateKey(originalKey);
      const decrypted = decryptOwnerPrivateKey(encrypted);

      expect(decrypted).toBe(originalKey);
    });

    it('round-trip: encrypt -> decrypt hoạt động chính xác', () => {
      const testKeys = [
        '0x1234567890abcdef1234567890abcdef',
        '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        '0xfedcba0987654321fedcba0987654321'
      ];

      testKeys.forEach(key => {
        const encrypted = encryptOwnerPrivateKey(key);
        const decrypted = decryptOwnerPrivateKey(encrypted);
        expect(decrypted).toBe(key);
      });
    });

    it('ném error khi encrypted key có định dạng không hợp lệ', () => {
      const invalidInputs = [
        'invalid-format',
        'only-one-part',
        'two:parts:here',
        '',
        '   '
      ];

      invalidInputs.forEach((invalidInput) => {
        expect(() => decryptOwnerPrivateKey(invalidInput as never)).toThrow();
      });
    });

    it('ném error khi encrypted key thiếu một trong các thành phần', () => {
      const invalidInputs = [
        'abcdef1234567890:abcdef1234567890',
        'abcdef1234567890::abcdef1234567890',
        ':abcdef1234567890:abcdef1234567890',
      ];

      invalidInputs.forEach((invalidInput) => {
        expect(() => decryptOwnerPrivateKey(invalidInput as never)).toThrow();
      });
    });

    it('ném error khi encrypted key bị tampered (authTag không match)', () => {
      const originalKey = '0x1234567890abcdef1234567890abcdef';
      const encrypted = encryptOwnerPrivateKey(originalKey);

      // Thay đổi một ký tự trong phần encrypted
      const parts = encrypted.split(':');
      const replacement = parts[1][0] === '0' ? '1' : '0';
      const tamperedEncrypted = `${parts[0]}:${replacement}${parts[1].slice(1)}:${parts[2]}`;

      try {
        decryptOwnerPrivateKey(tamperedEncrypted);
        throw new Error('Expected decryptOwnerPrivateKey to throw.');
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 409, errorCode: 'DECRYPTION_ERROR' });
      }
    });

  });
});
