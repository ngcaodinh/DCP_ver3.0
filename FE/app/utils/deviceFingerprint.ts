/**
 * Sinh device fingerprint cho guest session identification.
 * Mục đích: tạo hash ổn định từ các thuộc tính trình duyệt để nhận diện thiết bị,
 * phục vụ cho hệ thống chống spam và rate limiting ở backend.
 *
 * Lưu ý: KHÔNG sử dụng screen.width/height vì chúng thay đổi khi zoom hoặc xoay màn hình.
 * Thiết kế chống false positive: fingerprint chỉ thay đổi khi user đổi browser/device thực sự.
 */

/**
 * Chuyển đổi ArrayBuffer thành chuỗi hex.
 * Mục đích: convert raw bytes từ Web Crypto digest thành string để truyền qua API.
 * @param buffer - ArrayBuffer cần chuyển đổi
 * @returns Chuỗi hex viết thường
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  const hexChars = new Array(byteArray.length);
  for (let i = 0; i < byteArray.length; i++) {
    hexChars[i] = byteArray[i].toString(16).padStart(2, '0');
  }
  return hexChars.join('');
}

/**
 * Tính SHA-256 hash cho một chuỗi đầu vào sử dụng Web Crypto API.
 * Mục đích: đảm bảo fingerprint không thể bị đảo ngược, tăng tính privacy.
 * @param text - Chuỗi cần hash
 * @returns Hash SHA-256 dạng hex
 */
async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToHex(hashBuffer);
}

// Module-level Promise cache cho canvas fingerprint hash.
// Cache Promise thay vì string để tránh race condition khi hàm async được gọi đồng thời nhiều lần.
let canvasFingerprintPromise: Promise<string> | undefined = undefined;

/**
 * Reset canvas fingerprint cache — chỉ dùng trong tests.
 */
export function resetCanvasFingerprintCache(): void {
  canvasFingerprintPromise = undefined;
}

/**
 * Tạo canvas fingerprint để bổ sung entropy cho device fingerprint.
 * Mục đích: canvas hash phản ánh GPU driver và font rendering, tăng độ chính xác
 * trong việc phân biệt các thiết bị khác nhau.
 * @returns Chuỗi hex hash của canvas fingerprint hoặc empty string nếu thất bại
 */
async function getCanvasFingerprintHash(): Promise<string> {
  if (canvasFingerprintPromise !== undefined) {
    return canvasFingerprintPromise;
  }

  canvasFingerprintPromise = (async () => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return '';
      }

      canvas.width = 200;
      canvas.height = 50;

      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);

      ctx.fillStyle = '#069';
      ctx.fillText('DCP Guest Wallet Fingerprint', 2, 15);

      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('DCP Guest Wallet Fingerprint', 4, 17);

      ctx.font = '30px Arial';
      ctx.fillText('lock', 150, 10);

      const gradient = ctx.createLinearGradient(0, 0, 200, 0);
      gradient.addColorStop(0, 'red');
      gradient.addColorStop(0.5, 'green');
      gradient.addColorStop(1, 'blue');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 40, 200, 10);

      const dataUrl = canvas.toDataURL();
      return await sha256Hex(dataUrl);
    } catch {
      return '';
    }
  })();

  return canvasFingerprintPromise;
}

/**
 * Thu thập các thuộc tính trình duyệt ổn định cho fingerprint.
 * Mục đích: chỉ chọn các thuộc tính không thay đổi khi zoom/resize/orientation.
 * @returns Chuỗi kết hợp các thuộc tính trình duyệt
 */
function getStableBrowserAttributes(): string {
  const nav = navigator as Navigator & {
    hardwareConcurrency?: number;
    language?: string;
    platform?: string;
  };

  const attributes: string[] = [];

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    attributes.push(timeZone);
  } catch {
    // Ignore nếu không lấy được timezone
  }

  if (nav.language) {
    attributes.push(nav.language);
  }

  if (nav.platform) {
    attributes.push(nav.platform);
  }

  if (nav.hardwareConcurrency !== undefined) {
    attributes.push(String(nav.hardwareConcurrency));
  }

  return attributes.join('|');
}

/**
 * Hàm chính: sinh device fingerprint hash.
 * Mục đích: trả về SHA-256 hash tổng hợp từ browser attributes và canvas fingerprint.
 * Hash này được gửi lên backend để identify device, phục vụ rate limiting.
 *
 * Thiết kế chống false positive:
 * - Không dùng screen size (thay đổi khi zoom, responsive)
 * - Không dùng touch support (thay đổi khi cắm/rút chuột)
 * - Canvas hash phản ánh hardware thực, không thay đổi khi zoom
 *
 * @returns SHA-256 hash hex (64 ký tự) hoặc empty string nếu Web Crypto không khả dụng
 */
export async function generateDeviceFingerprint(): Promise<string> {
  try {
    const stableAttributes = getStableBrowserAttributes();
    const canvasHash = await getCanvasFingerprintHash();

    const combined = `${stableAttributes}::${canvasHash}`;

    const fingerprintHash = await sha256Hex(combined);
    return fingerprintHash;
  } catch {
    return '';
  }
}
