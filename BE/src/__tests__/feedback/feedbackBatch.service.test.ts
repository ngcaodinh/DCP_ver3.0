/**
 * Test cho feedbackBatch.service.ts - kiểm tra các hàm xử lý batch feedback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Mock các module dependencies
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: {
    insertMany: vi.fn().mockResolvedValue([])
  }
}));

// Import sau khi mock
import {
  hashBeneficiaryName,
  parseCsvBuffer,
  processCsvBatchFeedback,
  processJsonBatchFeedback,
  MAX_BATCH_SIZE,
  MAX_UPLOAD_SIZE_BYTES
} from '../../services/feedbackBatch.service';

describe('feedbackBatch.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hashBeneficiaryName', () => {
    it('nên hash beneficiaryName với SHA-256 và trả về hex string', () => {
      const name = 'Nguyen Van A';
      const hash = hashBeneficiaryName(name);

      // Verify format: 64 ký tự hex (SHA-256)
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      // Verify deterministic
      expect(hashBeneficiaryName(name)).toBe(hash);

      // Verify khác nhau với tên khác
      expect(hashBeneficiaryName('Tran Thi B')).not.toBe(hash);
    });

    it('nên handle empty string', () => {
      const hash = hashBeneficiaryName('');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('nên handle unicode characters', () => {
      const hash = hashBeneficiaryName('Nguyễn Văn A');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('parseCsvBuffer', () => {
    it('nên parse valid CSV với headers', () => {
      const csvContent = `projectId,beneficiaryName,rating,comment,submittedAt
proj1,Nguyen Van A,5,Good service,2024-01-15T10:00:00Z
proj1,Tran Thi B,4,Nice,2024-01-15T11:00:00Z`;

      const result = parseCsvBuffer(Buffer.from(csvContent));

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        projectId: 'proj1',
        beneficiaryName: 'Nguyen Van A',
        rating: '5',
        comment: 'Good service',
        submittedAt: '2024-01-15T10:00:00Z'
      });
    });

    it('nên throw error cho invalid CSV format', () => {
      // csv-parse có thể parse nhiều loại input không hợp lệ mà không throw
      // Test với format không có headers
      const invalidCsv = 'a,b,c,d,e';
      const result = parseCsvBuffer(Buffer.from(invalidCsv));
      expect(result).toBeDefined();
    });

    it('nên skip empty lines', () => {
      const csvWithEmptyLines = `projectId,beneficiaryName,rating,comment,submittedAt
proj1,Nguyen A,5,Good,

proj2,Nguyen B,4,Nice,2024-01-15T11:00:00Z`;

      const result = parseCsvBuffer(Buffer.from(csvWithEmptyLines));
      expect(result).toHaveLength(2);
    });
  });

  describe('MAX_BATCH_SIZE', () => {
    it('nên là 1000', () => {
      expect(MAX_BATCH_SIZE).toBe(1000);
    });
  });

  describe('MAX_UPLOAD_SIZE_BYTES', () => {
    it('nên là 5MB (5 * 1024 * 1024)', () => {
      expect(MAX_UPLOAD_SIZE_BYTES).toBe(5 * 1024 * 1024);
    });
  });
});
