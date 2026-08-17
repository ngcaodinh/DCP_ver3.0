import { describe, expect, it } from 'vitest';
import {
  detectFileTypeFromBuffer,
  getFileSizeLimit,
  ALLOWED_MIME_TYPES,
  FILE_SIZE_LIMITS
} from '../../services/upload-validation.service';
import { MAX_CSV_ROWS as MIDDLEWARE_MAX_CSV_ROWS } from '../../middleware/upload-validation.middleware';

describe('upload-validation.service', () => {

  // =========================================================================
  // Magic bytes detection — JPEG
  // =========================================================================
  describe('detectFileTypeFromBuffer — JPEG', () => {
    it('detect JPEG với signature FFD8FF (JFIF)', () => {
      const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.extension).toBe('jpg');
      expect(result.isValid).toBe(true);
    });

    it('detect JPEG với signature FFD8FFE1 (Exif)', () => {
      const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x11, 0x45, 0x78]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.extension).toBe('jpg');
      expect(result.isValid).toBe(true);
    });

    it('detect JPEG với signature FFD8FFEE (Adobe)', () => {
      const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xEE, 0x00, 0x0E, 0x41, 0x64]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.extension).toBe('jpg');
      expect(result.isValid).toBe(true);
    });
  });

  // =========================================================================
  // Magic bytes detection — PNG
  // =========================================================================
  describe('detectFileTypeFromBuffer — PNG', () => {
    it('detect PNG với signature 89504E470D0A1A0A', () => {
      const buffer = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
      ]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('image/png');
      expect(result.extension).toBe('png');
      expect(result.isValid).toBe(true);
    });
  });

  // =========================================================================
  // Magic bytes detection — WebP
  // =========================================================================
  describe('detectFileTypeFromBuffer — WebP', () => {
    it('detect WebP với RIFF container và WEBP signature', () => {
      // RIFF header: 52 49 46 46 (offset 0)
      // WEBP signature: at offset 8
      const buffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x00, 0x00, 0x00, 0x00
      ]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('image/webp');
      expect(result.extension).toBe('webp');
      expect(result.isValid).toBe(true);
    });
  });

  // =========================================================================
  // Magic bytes detection — CSV (text-based)
  // =========================================================================
  describe('detectFileTypeFromBuffer — CSV', () => {
    it('detect CSV với text header', () => {
      const buffer = Buffer.from('name,email,amount\nJohn,doe@example.com,100000');
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('text/csv');
      expect(result.extension).toBe('csv');
      expect(result.isValid).toBe(true);
    });

    it('detect CSV với BOM UTF-8', () => {
      const buffer = Buffer.from([0xEF, 0xBB, 0xBF, 0x6E, 0x61, 0x6D, 0x65]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('text/csv');
      expect(result.extension).toBe('csv');
      expect(result.isValid).toBe(true);
    });

    it('detect CSV với ký tự printable ASCII', () => {
      const buffer = Buffer.from('project,amount,status\nFood Bank,5000000,VND');
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('text/csv');
      expect(result.extension).toBe('csv');
      expect(result.isValid).toBe(true);
    });
  });

  describe('detectFileTypeFromBuffer — JSON', () => {
    it('detect JSON hợp lệ thay vì phân loại chung là CSV', () => {
      const result = detectFileTypeFromBuffer(Buffer.from('{"projectId":"project-1"}'));
      expect(result.mimeType).toBe('application/json');
      expect(result.extension).toBe('json');
      expect(result.isValid).toBe(true);
    });

    it('fallback JSON malformed về text heuristic để uploadType tự chặn', () => {
      const result = detectFileTypeFromBuffer(Buffer.from('{"projectId":}'));
      expect(result.mimeType).toBe('text/csv');
      expect(result.isValid).toBe(true);
    });
  });

  // =========================================================================
  // Magic bytes detection — unsupported types
  // =========================================================================
  describe('detectFileTypeFromBuffer — unsupported types', () => {
    it('không nhận WAV/RIFF là WebP nếu thiếu WEBP signature', () => {
      const buffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20
      ]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.extension).toBe('bin');
      expect(result.isValid).toBe(false);
    });

    it('detect EXE với MZ header → unsupported', () => {
      const buffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.extension).toBe('bin');
      expect(result.isValid).toBe(false);
    });

    it('detect PDF với %PDF header → unsupported (not in allowlist)', () => {
      const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.extension).toBe('pdf');
      expect(result.isValid).toBe(false);
    });

    it('detect ZIP với PK signature → unsupported', () => {
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.extension).toBe('bin');
      expect(result.isValid).toBe(false);
    });

    it('detect random binary bytes → unsupported', () => {
      const buffer = Buffer.from([0x00, 0xFF, 0x88, 0x12, 0xAA, 0x55, 0xCC, 0x33]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.isValid).toBe(false);
    });
  });

  // =========================================================================
  // Magic bytes detection — edge cases
  // =========================================================================
  describe('detectFileTypeFromBuffer — edge cases', () => {
    it('handle empty buffer', () => {
      const buffer = Buffer.from([]);
      const result = detectFileTypeFromBuffer(buffer);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.isValid).toBe(false);
    });

    it('handle buffer nhỏ hơn signature', () => {
      const buffer = Buffer.from([0xFF, 0xD8]);
      const result = detectFileTypeFromBuffer(buffer);
      // Sẽ rơi vào text-based check hoặc unknown
      expect(result).toHaveProperty('mimeType');
    });
  });

  // =========================================================================
  // File size limits
  // =========================================================================
  describe('getFileSizeLimit', () => {
    it('trả về 10MB cho image/jpeg', () => {
      expect(getFileSizeLimit('image/jpeg')).toBe(10 * 1024 * 1024);
    });

    it('trả về 10MB cho image/png', () => {
      expect(getFileSizeLimit('image/png')).toBe(10 * 1024 * 1024);
    });

    it('trả về 10MB cho image/webp', () => {
      expect(getFileSizeLimit('image/webp')).toBe(10 * 1024 * 1024);
    });

    it('trả về 5MB cho text/csv', () => {
      expect(getFileSizeLimit('text/csv')).toBe(5 * 1024 * 1024);
    });

    it('trả về 5MB cho application/json', () => {
      expect(getFileSizeLimit('application/json')).toBe(5 * 1024 * 1024);
    });

    it('trả về default 5MB cho unknown type', () => {
      expect(getFileSizeLimit('application/octet-stream')).toBe(5 * 1024 * 1024);
      expect(getFileSizeLimit('image/gif')).toBe(5 * 1024 * 1024);
      expect(getFileSizeLimit('')).toBe(5 * 1024 * 1024);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================
  describe('constants', () => {
    it('ALLOWED_MIME_TYPES chứa đúng các loại cho phép', () => {
      expect(ALLOWED_MIME_TYPES).toContain('image/jpeg');
      expect(ALLOWED_MIME_TYPES).toContain('image/png');
      expect(ALLOWED_MIME_TYPES).toContain('image/webp');
      expect(ALLOWED_MIME_TYPES).toContain('text/csv');
      expect(ALLOWED_MIME_TYPES).toContain('application/json');
      expect(ALLOWED_MIME_TYPES.length).toBe(5);
    });

    it('FILE_SIZE_LIMITS có đúng giới hạn cho từng type', () => {
      expect(FILE_SIZE_LIMITS['image/jpeg']).toBe(10 * 1024 * 1024);
      expect(FILE_SIZE_LIMITS['image/png']).toBe(10 * 1024 * 1024);
      expect(FILE_SIZE_LIMITS['image/webp']).toBe(10 * 1024 * 1024);
      expect(FILE_SIZE_LIMITS['text/csv']).toBe(5 * 1024 * 1024);
      expect(FILE_SIZE_LIMITS['application/json']).toBe(5 * 1024 * 1024);
    });

    it('MAX_CSV_ROWS = 1000 (from middleware)', () => {
      expect(MIDDLEWARE_MAX_CSV_ROWS).toBe(1000);
    });
  });
});
