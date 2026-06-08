/**
 * Lớp wrapper cho LocalStorage và SessionStorage dùng lưu trữ dữ liệu Guest Wallet.
 * Mục đích: cung cấp interface type-safe để lưu/truy xuất dữ liệu ví guest
 * từ browser storage, bao gồm encrypted owner key và session metadata.
 *
 * NGUYÊN TẮC BẢO MẬT:
 * - encryptedOwnerKey: lưu trong localStorage (cần persistent cho việc restore)
 * - guestSessionToken: lưu trong sessionStorage (chỉ tồn tại trong tab, tự clear khi đóng tab)
 * - serverSalt: lưu trong localStorage (cần persistent)
 */

/** Key dùng để lưu trữ dữ liệu ví guest trong LocalStorage (encrypted key, salts) */
const GUEST_WALLET_STORAGE_KEY = 'dcp_guest_wallet';

/** Key dùng để lưu trữ JWT token trong SessionStorage (tự clear khi đóng tab) */
const GUEST_SESSION_TOKEN_KEY = 'dcp_guest_session_token';

/**
 * Cấu trúc dữ liệu lưu trong LocalStorage cho Guest Wallet.
 * Lưu ý: guestSessionToken KHÔNG lưu trong LocalStorage — dùng sessionStorage riêng.
 * Việc tách token ra khỏi localStorage giảm thiểu rủi ro nếu localStorage bị đọc trái phép.
 */
export interface GuestWalletStorageData {
  /** Chuỗi hex của owner key đã được mã hóa AES-256-GCM */
  encryptedOwnerKey: string;
  /** Client salt dùng cho PBKDF2 key derivation (hex) */
  clientSalt: string;
  /** Server salt nhận được từ backend khi tạo session (hex) */
  serverSalt: string;
  /** Initialization vector dùng cho AES-GCM (hex) */
  iv: string;
  /** Địa chỉ ví guest (EIP-55 checksum) */
  walletAddress: string;
  /** ID của session đã tạo với backend */
  sessionId: string;
  /** Thời điểm hết hạn của session (ISO timestamp) */
  expiresAt: string;
  /** Thời điểm tạo wallet (ISO timestamp) */
  createdAt: string;
  /** Tổng số donation được phép trong session (từ API response) */
  donationQuota: number;
}

/**
 * Kiểm tra xem guest wallet data có tồn tại trong LocalStorage hay không.
 * @returns true nếu có dữ liệu guest wallet được lưu
 */
export function hasGuestWallet(): boolean {
  try {
    return localStorage.getItem(GUEST_WALLET_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Validate cấu trúc dữ liệu từ LocalStorage có đầy đủ các trường bắt buộc.
 * @param rawData - Dữ liệu thô parse từ JSON
 * @returns true nếu dữ liệu hợp lệ với đầy đủ required fields
 */
const STORAGE_STRING_FIELDS: (keyof GuestWalletStorageData)[] = [
  'encryptedOwnerKey',
  'clientSalt',
  'serverSalt',
  'iv',
  'walletAddress',
  'sessionId',
  'expiresAt',
  'createdAt',
];

function validateStorageData(rawData: unknown): rawData is GuestWalletStorageData {
  if (!rawData || typeof rawData !== 'object') {
    return false;
  }

  for (const field of STORAGE_STRING_FIELDS) {
    if (!(field in rawData) || typeof (rawData as Record<string, unknown>)[field] !== 'string') {
      return false;
    }
  }

  // Validate donationQuota
  if (!('donationQuota' in rawData) || typeof (rawData as Record<string, unknown>).donationQuota !== 'number') {
    return false;
  }

  // Validate walletAddress format (EIP-55 hex)
  const wallet = (rawData as GuestWalletStorageData).walletAddress;
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return false;
  }

  // Validate string lengths to prevent corrupted storage data
  const encryptedKey: string = (rawData as Record<string, unknown>).encryptedOwnerKey as string;
  const clientSalt: string = (rawData as Record<string, unknown>).clientSalt as string;
  const serverSalt: string = (rawData as Record<string, unknown>).serverSalt as string;
  const iv: string = (rawData as Record<string, unknown>).iv as string;

  if (
    encryptedKey.length < 16 ||
    clientSalt.length < 16 ||
    serverSalt.length < 16 ||
    iv.length < 16
  ) {
    return false;
  }

  return true;
}

/**
 * Load guest wallet data từ LocalStorage.
 * @returns GuestWalletStorageData nếu tồn tại và hợp lệ, null nếu không có hoặc lỗi
 */
export function loadGuestWallet(): GuestWalletStorageData | null {
  try {
    const rawJson = localStorage.getItem(GUEST_WALLET_STORAGE_KEY);
    if (!rawJson) {
      return null;
    }

    const parsedData = JSON.parse(rawJson) as unknown;

    if (!validateStorageData(parsedData)) {
      // Chỉ log message, không log error object để tránh lộ thông tin internal
      console.warn('[GuestWalletStorage] Dữ liệu trong LocalStorage không hợp lệ, xóa bỏ.');
      localStorage.removeItem(GUEST_WALLET_STORAGE_KEY);
      return null;
    }

    return parsedData;
  } catch {
    // Chỉ log message, không log error object
    console.error('[GuestWalletStorage] Lỗi khi đọc dữ liệu từ LocalStorage.');
    return null;
  }
}

/**
 * Lưu guest wallet data vào LocalStorage.
 * @param data - GuestWalletStorageData cần lưu
 */
export function saveGuestWallet(data: GuestWalletStorageData): void {
  try {
    const jsonString = JSON.stringify(data);
    localStorage.setItem(GUEST_WALLET_STORAGE_KEY, jsonString);
  } catch {
    // Chỉ log message, không log error object
    console.error('[GuestWalletStorage] Lỗi khi lưu dữ liệu vào LocalStorage.');
    throw new Error('Không thể lưu dữ liệu guest wallet vào LocalStorage.');
  }
}

/**
 * Xóa toàn bộ guest wallet data khỏi LocalStorage.
 * Dùng khi user logout, claim thành công, hoặc user chủ động xóa.
 */
export function clearGuestWallet(): void {
  try {
    localStorage.removeItem(GUEST_WALLET_STORAGE_KEY);
  } catch {
    // Chỉ log message, không log error object
    console.error('[GuestWalletStorage] Lỗi khi xóa dữ liệu từ LocalStorage.');
  }
}

/**
 * Kiểm tra xem session đã hết hạn chưa dựa trên expiresAt.
 * @param data - GuestWalletStorageData cần kiểm tra
 * @returns true nếu session đã hết hạn
 */
export function isSessionExpired(data: GuestWalletStorageData): boolean {
  try {
    const expiryTime = new Date(data.expiresAt).getTime();
    if (Number.isNaN(expiryTime)) {
      return true;
    }
    return Date.now() > expiryTime;
  } catch {
    return true;
  }
}

/* ============================================================
 * SESSION TOKEN MANAGEMENT (sessionStorage)
 * Token lưu riêng trong sessionStorage — không tồn tại khi đóng tab
 * ============================================================ */

/**
 * Lưu guest session token vào sessionStorage.
 * Token chỉ tồn tại trong tab hiện tại — tự clear khi đóng tab.
 * @param token - JWT token từ server
 * @param expiresAt - Thời điểm hết hạn (để kiểm tra khi đọc)
 */
export function saveGuestSessionToken(token: string, expiresAt: string): void {
  try {
    sessionStorage.setItem(GUEST_SESSION_TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    // sessionStorage có thể bị blocked trong một số trình duyệt (Safari Private Mode)
    throw new Error('Không thể lưu session token. Trình duyệt có thể đang chặn sessionStorage.');
  }
}

/**
 * Đọc guest session token từ sessionStorage.
 * @returns Token và expiry nếu tồn tại và chưa hết hạn, null nếu không có hoặc hết hạn
 */
export function loadGuestSessionToken(): { token: string; expiresAt: string } | null {
  try {
    const raw = sessionStorage.getItem(GUEST_SESSION_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token: string; expiresAt: string };
    const expiryTime = new Date(parsed.expiresAt).getTime();
    if (Number.isNaN(expiryTime) || Date.now() > expiryTime) {
      sessionStorage.removeItem(GUEST_SESSION_TOKEN_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Xóa guest session token khỏi sessionStorage.
 */
export function clearGuestSessionToken(): void {
  try {
    sessionStorage.removeItem(GUEST_SESSION_TOKEN_KEY);
  } catch {
    // ignore
  }
}
