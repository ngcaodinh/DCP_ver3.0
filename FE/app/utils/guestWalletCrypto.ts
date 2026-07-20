/**
 * Các hàm mã hóa/giải mã owner key cho Guest Wallet sử dụng Web Crypto API.
 * Mục đích: bảo vệ private key của guest wallet bằng AES-256-GCM,
 * với derivation key từ device fingerprint và server salt thông qua PBKDF2.
 * KHÔNG có dependency bên ngoài — chỉ dùng Web Crypto API có sẵn trong trình duyệt.
 */

/** Số vòng lặp PBKDF2 — đủ lớn để chống brute-force, không quá chậm trên thiết bị yếu */
const PBKDF2_ITERATIONS = 100_000;

/** Độ dài key AES-256 (256 bits = 32 bytes) */
const AES_KEY_LENGTH = 256;

/** Độ dài IV cho AES-GCM (96 bits = 12 bytes theo NIST recommendation) */
const IV_LENGTH_BYTES = 12;

/** Độ dài salt ngẫu nhiên phía client (16 bytes) */
const CLIENT_SALT_LENGTH_BYTES = 16;

/** Chuỗi để phân biệt key derivation với các mục đích khác */
const KEY_DERIVATION_CONTEXT = 'dcp-guest-wallet-v1';

/**
 * Chuyển ArrayBuffer/Uint8Array thành chuỗi hex.
 * @param source - Buffer nguồn
 * @returns Chuỗi hex viết thường
 */
function arrayBufferToHex(source: ArrayBuffer | ArrayBufferLike | Uint8Array): string {
  const byteArray = source instanceof Uint8Array ? source : new Uint8Array(source as ArrayBuffer);
  return Array.from(byteArray)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Tạo ArrayBuffer thuần từ Uint8Array.
 * Mục đích: Web Crypto trong Node/jsdom từ chối SharedArrayBuffer hoặc buffer view không chuẩn.
 */
function toPlainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return copy;
}

/**
 * Chuyển chuỗi hex thành ArrayBuffer thuần (không phải SharedArrayBuffer).
 * @param hex - Chuỗi hex cần chuyển đổi
 * @returns ArrayBuffer chứa bytes tương ứng
 */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  // Strip 0x prefix nếu có
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  // Phát hiện ký tự không hợp lệ — throw thay vì silent strip để tránh confuse
  if (!/^[a-fA-F0-9]+$/.test(cleanHex)) {
    throw new Error('Chuỗi hex không hợp lệ: có ký tự không phải hex.');
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let index = 0; index < cleanHex.length; index += 2) {
    bytes[index / 2] = parseInt(cleanHex.substring(index, index + 2), 16);
  }
  // slice() tạo copy với ArrayBuffer thuần, tránh SharedArrayBuffer
  return toPlainBytes(bytes);
}

/**
 * Sinh salt ngẫu nhiên từ Web Crypto API.
 * @returns Chuỗi hex của 16-byte random salt
 */
export function generateClientSalt(): string {
  const saltBytes = new Uint8Array(CLIENT_SALT_LENGTH_BYTES);
  crypto.getRandomValues(saltBytes);
  return arrayBufferToHex(saltBytes);
}

/**
 * Nhường quyền điều khiển cho main thread trước khi thực hiện PBKDF2.
 * Mục đích: tránh blocking UI vì PBKDF2 (100k iterations) có thể tốn ~100-300ms.
 */
async function yieldToMain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Derive AES-256 key từ password (deviceFingerprint + serverSalt) sử dụng PBKDF2.
 * Mục đích: biến fingerprint và server salt thành cryptographic key ổn định.
 * @param deviceFingerprint - SHA-256 hash của device fingerprint (hex)
 * @param serverSalt - Server-generated salt nhận được từ backend (hex)
 * @param clientSalt - Client-generated salt (hex, từ generateClientSalt)
 * @returns CryptoKey dùng cho AES-GCM
 */
async function deriveAesKey(
  deviceFingerprint: string,
  serverSalt: string,
  clientSalt: string,
): Promise<CryptoKey> {
  const passwordString = `${KEY_DERIVATION_CONTEXT}|${deviceFingerprint}|${serverSalt}`;
  const encoder = new TextEncoder();
  const passwordBytes = toPlainBytes(encoder.encode(passwordString));

  // Dùng ArrayBuffer thuần cho salt — tránh SharedArrayBuffer TypeScript error
  const combinedSalt = hexToBytes(serverSalt + clientSalt);

  // Nhường quyền cho main thread trước khi bắt đầu CPU-intensive PBKDF2
  await yieldToMain();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: combinedSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );

  return aesKey;
}

/**
 * Mã hóa owner key bằng AES-256-GCM.
 * @param ownerKey - Private key dạng hex (có hoặc không có prefix 0x — chuẩn hóa bên trong)
 * @param deviceFingerprint - SHA-256 hash của device fingerprint (hex)
 * @param serverSalt - Server salt nhận được từ backend (hex)
 * @returns Object chứa encrypted data và metadata cần thiết để giải mã
 */
export async function encryptOwnerKey(
  ownerKey: string,
  deviceFingerprint: string,
  serverSalt: string,
): Promise<{
  encryptedOwnerKey: string;
  clientSalt: string;
  iv: string;
}> {
  const clientSalt = generateClientSalt();
  const ivBytes = new Uint8Array(IV_LENGTH_BYTES);
  crypto.getRandomValues(ivBytes);
  const iv = arrayBufferToHex(ivBytes);
  // Dùng ArrayBuffer thuần cho IV trong AES-GCM params
  const ivBuffer = toPlainBytes(ivBytes);

  const aesKey = await deriveAesKey(deviceFingerprint, serverSalt, clientSalt);

  // Chuẩn hóa: ethers v6 Wallet.privateKey luôn có prefix 0x, strip trước khi encrypt
  // để đảm bảo consistent format: 64 ký tự hex không có 0x (dùng cho cả ethers và non-ethers)
  const cleanOwnerKey = ownerKey.startsWith('0x') ? ownerKey.slice(2) : ownerKey;
  const encoder = new TextEncoder();
  const ownerKeyBytes = toPlainBytes(encoder.encode(cleanOwnerKey));

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    aesKey,
    ownerKeyBytes,
  );

  const encryptedHex = arrayBufferToHex(encryptedBuffer);

  return {
    encryptedOwnerKey: encryptedHex,
    clientSalt,
    iv,
  };
}

/**
 * Giải mã owner key từ dữ liệu đã mã hóa.
 * @param encryptedData - Object chứa encryptedOwnerKey, clientSalt, iv
 * @param deviceFingerprint - SHA-256 hash của device fingerprint (hex)
 * @param serverSalt - Server salt nhận được từ backend (hex)
 * @returns Owner key dạng hex gốc
 * @throws Error nếu giải mã thất bại (sai credentials hoặc data corrupted)
 */
export async function decryptOwnerKey(
  encryptedData: { encryptedOwnerKey: string; clientSalt: string; iv: string },
  deviceFingerprint: string,
  serverSalt: string,
): Promise<string> {
  const { encryptedOwnerKey, clientSalt, iv } = encryptedData;

  const aesKey = await deriveAesKey(deviceFingerprint, serverSalt, clientSalt);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(iv) },
      aesKey,
      hexToBytes(encryptedOwnerKey),
    );
  } catch {
    throw new Error('Giải mã thất bại. Vui lòng kiểm tra lại thiết bị và phiên làm việc.');
  }

  const decoder = new TextDecoder();
  const decryptedText = decoder.decode(decryptedBuffer);

  // Owner key phải là hex string hợp lệ (64 ký tự hex không có prefix 0x)
  const hexPattern = /^[a-fA-F0-9]{64}$/;
  if (!hexPattern.test(decryptedText)) {
    throw new Error('Dữ liệu giải mã không hợp lệ. Device fingerprint hoặc session có thể đã thay đổi.');
  }

  return decryptedText;
}
