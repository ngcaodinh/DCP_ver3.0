/**
 * Service xác định MIME type thực sự của file bằng magic bytes (file signature).
 * Dùng cho trường hợp extension bị đổi hoặc thiếu.
 * Ref: https://en.wikipedia.org/wiki/List_of_file_signatures
 */

export type DetectedFileType = {
  mimeType: string;
  extension: string;
  isValid: boolean;
};

/**
 * Map từ magic bytes signature sang MIME type và extension.
 * Mỗi entry chứa: offset (vị trí bắt đầu đọc), signature (hex bytes cần match), mimeType, extension.
 */
const SIGNATURE_MAP: Array<{
  offset: number;
  signatures: Array<{ bytes: string; mimeType: string; extension: string }>;
}> = [
  {
    offset: 0,
    signatures: [
      // JPEG
      { bytes: 'FFD8FF', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFE0', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFE1', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFE2', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFE3', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFDB', mimeType: 'image/jpeg', extension: 'jpg' },
      { bytes: 'FFD8FFEE', mimeType: 'image/jpeg', extension: 'jpg' },
      // PNG
      { bytes: '89504E470D0A1A0A', mimeType: 'image/png', extension: 'png' },
      // GIF
      { bytes: '47494638', mimeType: 'image/gif', extension: 'gif' },
      // WebP (RIFF container)
      { bytes: '52494646', mimeType: 'image/webp', extension: 'webp' },
      // PDF
      { bytes: '25504446', mimeType: 'application/pdf', extension: 'pdf' },
    ]
  },
  {
    offset: 4,
    signatures: [
      // WebP (WEBP signature inside RIFF container)
      { bytes: '57454250', mimeType: 'image/webp', extension: 'webp' },
    ]
  }
];

/**
 * Danh sách các MIME type được phép upload.
 * Thống nhất với whitelist trong upload-validation.middleware.ts.
 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'application/json'
] as const;

/**
 * Giới hạn kích thước file theo loại.
 */
export const FILE_SIZE_LIMITS: Record<string, number> = {
  'image/jpeg': 10 * 1024 * 1024,    // 10MB
  'image/png':  10 * 1024 * 1024,    // 10MB
  'image/webp': 10 * 1024 * 1024,    // 10MB
  'text/csv':   5 * 1024 * 1024,    // 5MB
  'application/json': 5 * 1024 * 1024, // 5MB
} as const;

/**
 * Magic bytes tối đa cần đọc (tính bằng bytes).
 * Đủ để cover tất cả signatures trong SIGNATURE_MAP.
 */
const MAX_SIGNATURE_LENGTH = 16;

/**
 * Chuyển buffer thành hex string.
 */
function bufferToHex(buffer: Buffer, offset: number, length: number): string {
  return buffer.slice(offset, offset + length).toString('hex').toUpperCase();
}

/**
 * Xác định MIME type thực sự của file từ magic bytes.
 * Không dựa vào extension hay Content-Type header.
 * Ưu tiên binary signatures (chính xác), sau đó mới text detection (heuristic).
 *
 * @param buffer - Buffer chứa file data đã đọc
 * @returns DetectedFileType chứa mimeType, extension, và isValid
 */
export function detectFileTypeFromBuffer(buffer: Buffer): DetectedFileType {
  // Edge case: empty buffer
  if (buffer.length === 0) {
    return {
      mimeType: 'application/octet-stream',
      extension: 'bin',
      isValid: false
    };
  }

  // Bước 1: Kiểm tra binary signatures (chính xác, không ambiguous).
  for (const entry of SIGNATURE_MAP) {
    if (entry.offset >= buffer.length) continue;

    const hexAtOffset = bufferToHex(buffer, entry.offset, MAX_SIGNATURE_LENGTH);

    for (const sig of entry.signatures) {
      if (!sig.bytes) continue;

      if (hexAtOffset.startsWith(sig.bytes)) {
        return {
          mimeType: sig.mimeType,
          extension: sig.extension,
          isValid: ALLOWED_MIME_TYPES.includes(sig.mimeType as typeof ALLOWED_MIME_TYPES[number])
        };
      }
    }
  }

  // Bước 2: Text detection (heuristic fallback).
  // Kiểm tra BOM UTF-8 trước (0xEF 0xBB 0xBF)
  const startsWithBomUtf8 =
    buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;

  // Kiểm tra từng byte: text file thật sự có tất cả bytes printable ASCII.
  const firstBytes = buffer.slice(0, Math.min(8, buffer.length));
  let printableCount = 0;

  for (let i = 0; i < firstBytes.length; i++) {
    const byte = firstBytes[i];
    // Printable ASCII: space(0x20) → tilde(0x7E), tab(0x09), LF(0x0A), CR(0x0D)
    const isPrintable =
      (byte >= 0x20 && byte <= 0x7E) ||
      byte === 0x09 ||
      byte === 0x0A ||
      byte === 0x0D;
    if (isPrintable) printableCount++;
  }

  const isTextBased = printableCount === firstBytes.length;

  if (isTextBased || startsWithBomUtf8) {
    return {
      mimeType: 'text/csv',
      extension: 'csv',
      isValid: true
    };
  }

  // Không match signature nào và không phải text → unknown binary type
  return {
    mimeType: 'application/octet-stream',
    extension: 'bin',
    isValid: false
  };
}

/**
 * Lấy giới hạn kích thước cho một MIME type.
 *
 * @param mimeType - MIME type của file
 * @returns Giới hạn kích thước tính bằng bytes, hoặc default 5MB nếu không có
 */
export function getFileSizeLimit(mimeType: string): number {
  return FILE_SIZE_LIMITS[mimeType] ?? (5 * 1024 * 1024);
}
