/**
 * Các hàm mã hóa/giải mã phục vụ guest wallet relay.
 * Mục đích: tái tạo PBKDF2 AES-256-GCM decryption trên Node.js (BE)
 * để giải mã owner key từ layer FE đã mã hóa bằng Web Crypto API.
 *
 * Lưu ý: File này tách biệt với zeroDevService.ts vì chỉ phục vụ
 * guest wallet relay flow, không dùng chung với registered user flow.
 */
import crypto from 'crypto';

/** Số vòng lặp PBKDF2 — phải khớp với FE (guestWalletCrypto.ts) */
const PBKDF2_ITERATIONS = 100_000;

/** Độ dài key AES-256 (256 bits = 32 bytes) */
const AES_KEY_LENGTH = 32;

/** Độ dài IV cho AES-GCM (96 bits = 12 bytes theo NIST recommendation) */
const IV_LENGTH_BYTES = 12;

/** Context string phân biệt key derivation — phải khớp với FE */
const KEY_DERIVATION_CONTEXT = 'dcp-guest-wallet-v1';

/** Chuỗi hex dùng để phân biệt key derivation với các mục đích khác */
const FE_DERIVATION_CONTEXT = 'dcp-guest-wallet-v1';

/**
 * Chuyển chuỗi hex thành Buffer.
 * @param hex - Chuỗi hex (có hoặc không có prefix 0x)
 * @returns Buffer chứa bytes tương ứng
 */
function hexToBuffer(hex: string): Buffer {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(cleanHex, 'hex');
}

/**
 * Chuyển Buffer/Uint8Array thành chuỗi hex viết thường.
 * @param source - Buffer nguồn
 * @returns Chuỗi hex viết thường
 */
function bufferToHex(source: Buffer | Uint8Array): string {
  const byteArray = source instanceof Uint8Array ? source : source;
  return Buffer.from(byteArray).toString('hex');
}

/**
 * Dữ liệu encrypted owner key từ FE.
 * Khớp với output của encryptOwnerKey() trong guestWalletCrypto.ts (FE).
 */
export interface FeEncryptedOwnerKey {
  /** Chuỗi hex của ciphertext đã mã hóa AES-256-GCM */
  encryptedOwnerKey: string;
  /** Client salt dùng cho PBKDF2 (hex, 16 bytes) */
  clientSalt: string;
  /** Initialization vector dùng cho AES-GCM (hex, 12 bytes) */
  iv: string;
}

/**
 * Hàm giải mã owner key từ FE-PBKDF2 layer.
 *
 * FE mã hóa bằng Web Crypto API với quy trình:
 * 1. passwordString = "dcp-guest-wallet-v1|fingerprint|serverSalt"
 * 2. salt = serverSalt_hex + clientSalt_hex (concatenated hex)
 * 3. PBKDF2 với 100,000 iterations, SHA-256
 * 4. AES-256-GCM encrypt với IV ngẫu nhiên
 *
 * BE cần tái tạo chính xác quy trình này để giải mã.
 *
 * @param feEncryptedKey - Dữ liệu encrypted từ FE (encryptedOwnerKey, clientSalt, iv)
 * @param deviceFingerprintHash - SHA-256 hash của device fingerprint (hex, 64 chars)
 * @param serverSalt - Server salt nhận được từ session creation (hex, 64 chars)
 * @returns Raw owner key dạng hex (64 ký tự không có prefix 0x)
 * @throws Error nếu giải mã thất bại (sai credentials hoặc data corrupted)
 */
export function decryptPbkdf2Layer(
  feEncryptedKey: FeEncryptedOwnerKey,
  deviceFingerprintHash: string,
  serverSalt: string
): string {
  const { encryptedOwnerKey, clientSalt, iv } = feEncryptedKey;

  // Bước 1: Tái tạo password string — phải khớp chính xác với FE
  // FE: `passwordString = \`${KEY_DERIVATION_CONTEXT}|${deviceFingerprint}|${serverSalt}\``
  const passwordString = `${KEY_DERIVATION_CONTEXT}|${deviceFingerprintHash}|${serverSalt}`;

  // Bước 2: Tái tạo salt — FE dùng serverSalt + clientSalt (hex concatenated)
  // hex concat: serverSalt(64 hex) + clientSalt(32 hex) = 96 hex chars
  const combinedSaltHex = serverSalt + clientSalt;
  const combinedSalt = hexToBuffer(combinedSaltHex);

  // Bước 3: PBKDF2 derivation — phải khớp với FE settings
  // FE: iterations=100000, hash=SHA-256, keyLength=256 bits
  const derivedKey = crypto.pbkdf2Sync(
    passwordString,
    combinedSalt,
    PBKDF2_ITERATIONS,
    AES_KEY_LENGTH,
    'sha256'
  );

  // Bước 4: AES-256-GCM decrypt
  const ivBuffer = hexToBuffer(iv);
  const ciphertextBuffer = hexToBuffer(encryptedOwnerKey);

  // AES-GCM auth tag nằm ở cuối ciphertext (16 bytes = last 32 hex chars)
  // Ciphertext format: [encrypted_data][auth_tag] — total length phải >= 16
  if (ciphertextBuffer.length < 16) {
    throw new Error('Ciphertext quá ngắn để chứa auth tag.');
  }

  const authTagLength = 16; // AES-GCM tag luôn 16 bytes
  const encryptedData = ciphertextBuffer.subarray(0, ciphertextBuffer.length - authTagLength);
  const authTag = ciphertextBuffer.subarray(ciphertextBuffer.length - authTagLength);

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, ivBuffer);
  decipher.setAuthTag(authTag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch {
    throw new Error('Giải mã PBKDF2 layer thất bại. Vui lòng kiểm tra credentials.');
  }

  const decryptedText = decrypted.toString('utf8');

  // Validate: owner key phải là hex string 64 ký tự không có prefix 0x
  // ethers v6 Wallet.privateKey luôn có prefix 0x, nhưng FE strip trước khi encrypt
  const hexPattern = /^[a-fA-F0-9]{64}$/;
  if (!hexPattern.test(decryptedText)) {
    throw new Error('Dữ liệu giải mã không hợp lệ. Device fingerprint hoặc salt có thể đã thay đổi.');
  }

  return decryptedText;
}
