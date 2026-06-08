/**
 * Kiểm tra khả năng tương thích của trình duyệt với tính năng Guest Wallet.
 * Mục đích: phát hiện sớm các trình duyệt không hỗ trợ LocalStorage, Brave Strict mode,
 * hoặc Safari Private Mode để hiển thị cảnh báo phù hợp cho người dùng.
 * @returns Object chứa mức độ rủi ro và danh sách chi tiết các vấn đề phát hiện được
 */
export type BrowserCompatibilityRiskLevel = 'SAFE' | 'WARNING' | 'CRITICAL';

export interface BrowserCompatibilityResult {
  riskLevel: BrowserCompatibilityRiskLevel;
  details: string[];
}

/**
 * Kiểm tra LocalStorage có hoạt động hay không bằng cách ghi và đọc dữ liệu.
 * Mục đích: phát hiện trình duyệt chặn LocalStorage (Private Mode, Safari, Firefox Strict).
 * @returns true nếu LocalStorage hoạt động bình thường
 */
async function isLocalStorageAvailable(): Promise<boolean> {
  try {
    const testKey = `__dcp_ls_test_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}__`;
    localStorage.setItem(testKey, '1');
    const result = localStorage.getItem(testKey) === '1';
    localStorage.removeItem(testKey);
    return result;
  } catch {
    return false;
  }
}

/**
 * Phát hiện Brave Browser ở chế độ Strict mode.
 * Mục đích: Brave Strict mode có thể chặn một số tính năng fingerprinting.
 * @returns true nếu phát hiện Brave Strict mode
 */
async function isBraveStrictMode(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('brave' in navigator)) {
      return false;
    }
    const brave = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
    if (brave.brave?.isBrave) {
      // Timeout 3 giây để tránh Promise treo vĩnh viễn khi Brave API không phản hồi.
      // Promise.race ensure rằng init flow không bị chặn bởi Brave detection.
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 3000);
      });
      return Promise.race([brave.brave.isBrave(), timeoutPromise]);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Phát hiện Safari Private Mode bằng heuristic quota.
 * Mục đích: Safari Private Mode giới hạn quota storage rất thấp (~0), khiến
 * LocalStorage hoạt động bất thường. Kiểm tra bằng cách thử quota storage.
 * @returns true nếu nghi ngờ Safari Private Mode
 */
async function isSafariPrivateMode(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('storage' in navigator)) {
      return false;
    }
    if ('estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      // Safari Private Mode có quota rất thấp (< 1MB)
      return quota > 0 && quota < 1_000_000;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Phát hiện trình duyệt không hỗ trợ Web Crypto API.
 * Mục đích: Guest Wallet cần Web Crypto API cho mã hóa owner key.
 * @returns true nếu Web Crypto API không khả dụng
 */
function isWebCryptoUnavailable(): boolean {
  try {
    // Kiểm tra cả null lẫn undefined vì jsdom environment có crypto.subtle = null
    return typeof crypto === 'undefined' || crypto.subtle === null || typeof crypto.subtle === 'undefined';
  } catch {
    return true;
  }
}

/**
 * Hàm chính: kiểm tra toàn diện khả năng tương thích trình duyệt.
 * Mục đích: trả về riskLevel và danh sách vấn đề để frontend hiển thị cảnh báo.
 */
export async function detectBrowserCompatibility(): Promise<BrowserCompatibilityResult> {
  const details: string[] = [];

  const [localStorageAvailable, braveStrict, safariPrivate, cryptoUnavailable] = await Promise.all([
    isLocalStorageAvailable(),
    isBraveStrictMode(),
    isSafariPrivateMode(),
    Promise.resolve(isWebCryptoUnavailable()),
  ]);

  if (!localStorageAvailable) {
    details.push('Trình duyệt không hỗ trợ LocalStorage. Dữ liệu ví sẽ không được lưu giữ.');
  }

  if (braveStrict) {
    details.push('Brave Strict mode đang bật. Một số tính năng bảo mật có thể bị ảnh hưởng.');
  }

  if (safariPrivate) {
    details.push('Phát hiện chế độ Private của Safari. Dữ liệu ví có thể không được lưu lâu dài.');
  }

  if (cryptoUnavailable) {
    details.push('Trình duyệt không hỗ trợ Web Crypto API. Không thể mã hóa owner key.');
  }

  // Xác định mức độ rủi ro
  let riskLevel: BrowserCompatibilityRiskLevel = 'SAFE';

  if (details.length >= 2 || cryptoUnavailable || !localStorageAvailable) {
    riskLevel = 'CRITICAL';
  } else if (details.length >= 1) {
    riskLevel = 'WARNING';
  }

  return { riskLevel, details };
}
