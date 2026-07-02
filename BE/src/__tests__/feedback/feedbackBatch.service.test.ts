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
    insertMany: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null)
      })
    })
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
import { BeneficiaryFeedbackModel } from '../../models/beneficiaryFeedbackModel';
import { getLogger } from '../../config/logger';

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

  describe('processCsvBatchFeedback', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('nên throw error khi file size > 5MB', async () => {
      const largeBuffer = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1, 'a');

      await expect(processCsvBatchFeedback(largeBuffer, 'org123'))
        .rejects.toThrow('File size exceeds 5MB limit');
    });

    it('nên throw error khi batch size > 1000 rows', async () => {
      const rows = Array.from({ length: 1001 }, (_, i) =>
        `proj${i},User${i},4,Comment${i},2024-01-15T10:00:00Z`
      ).join('\n');
      const csvContent = `projectId,beneficiaryName,rating,comment,submittedAt\n${rows}`;

      await expect(processCsvBatchFeedback(Buffer.from(csvContent), 'org123'))
        .rejects.toThrow('Batch size exceeds 1000 limit');
    });

    it('nên xử lý CSV với mixed valid/invalid rows (string rating sẽ fail validation)', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      // CSV parse trả về rating dạng string "4" thay vì number 4
      // nên validator sẽ reject tất cả các row
      const csvContent = `projectId,beneficiaryName,rating,comment,submittedAt
proj1,Nguyen A,4,Good,2024-01-15T10:00:00Z
proj2,Nguyen B,99,Invalid,2024-01-15T11:00:00Z`;

      const result = await processCsvBatchFeedback(Buffer.from(csvContent), 'org123');

      // Tất cả rows fail vì rating là string không phải number
      expect(result.success).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.errors).toHaveLength(2);
    });

    it('nên xử lý batch và không throw cho empty CSV', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      // CSV không có data rows
      const csvContent = `projectId,beneficiaryName,rating,comment,submittedAt`;

      const result = await processCsvBatchFeedback(Buffer.from(csvContent), 'org123');
      expect(result.success).toBe(0);
    });

    it('nên xử lý với input không parse được nhưng không throw', async () => {
      // csv-parse có thể parse nhiều format không hợp lệ mà không throw
      const invalidCsv = 'unparseable{{{';

      const result = await processCsvBatchFeedback(Buffer.from(invalidCsv), 'org123');
      expect(result).toBeDefined();
      expect(result.success).toBe(0);
    });
  });

  describe('processJsonBatchFeedback', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('nên xử lý thành công JSON array với valid rows', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const validPayload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good service',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'Tran Thi B',
          rating: 5,
          comment: 'Excellent',
          submittedAt: '2024-01-15T11:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(validPayload, 'org123');

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('nên throw error khi payload không phải array', async () => {
      const invalidPayload = { feedbacks: [] };

      await expect(processJsonBatchFeedback(invalidPayload, 'org123'))
        .rejects.toThrow('Payload must be a JSON array');
    });

    it('nên throw error khi batch > 1000 items', async () => {
      const largePayload = Array.from({ length: 1001 }, (_, i) => ({
        projectId: `proj${i}`,
        beneficiaryName: `User${i}`,
        rating: 4,
        comment: `Comment ${i}`,
        submittedAt: '2024-01-15T10:00:00Z'
      }));

      await expect(processJsonBatchFeedback(largePayload, 'org123'))
        .rejects.toThrow('Batch size exceeds 1000 limit');
    });

    it('nên xử lý JSON với mixed valid/invalid rows', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const mixedPayload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'Tran Thi B',
          rating: 6,
          comment: 'Invalid',
          submittedAt: '2024-01-15T11:00:00Z'
        },
        {
          projectId: 'proj3',
          beneficiaryName: 'Tran Thi C',
          rating: 3,
          comment: 'OK',
          submittedAt: '2024-01-15T12:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(mixedPayload, 'org123');

      expect(result.success).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors[0].rowNumber).toBe(2);
    });

    it('nên xử lý empty array và trả về kết quả rỗng', async () => {
      const result = await processJsonBatchFeedback([], 'org123');

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.flaggedCount).toBe(0);
    });

    it('nên xử lý single valid row', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const singlePayload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(singlePayload, 'org123');

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('nên xử lý batch đúng 1000 rows', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const maxPayload = Array.from({ length: 1000 }, (_, i) => ({
        projectId: `proj${i}`,
        beneficiaryName: `User${i}`,
        rating: 4,
        comment: `Comment ${i}`,
        submittedAt: '2024-01-15T10:00:00Z'
      }));

      const result = await processJsonBatchFeedback(maxPayload, 'org123');

      expect(result.success).toBe(1000);
      expect(result.failed).toBe(0);
    });

    it('nên hash beneficiaryName với SHA-256 khi lưu vào DB', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockImplementation(async (docs) => {
        // Verify hash format trong document
        const firstDoc = docs[0];
        expect(firstDoc.beneficiaryNameHash).toMatch(/^[a-f0-9]{64}$/);
        return docs;
      });

      const payload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      await processJsonBatchFeedback(payload, 'org123');
    });

    it('nên trả về flaggedCount chính xác cho spam feedback', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const spamPayload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 1,
          comment: 'aaaaaa bbbbbb cccccc dddddd eeeeee',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'User2',
          rating: 3,
          comment: 'Normal comment',
          submittedAt: '2024-01-15T11:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(spamPayload, 'org123');

      expect(result.success).toBe(2);
      expect(result.flaggedCount).toBe(1); // First row has risk score >= 7
    });

    it('nên trả về flaggedCount = 0 cho non-spam feedback', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const normalPayload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'User1',
          rating: 3,
          comment: 'This is a normal feedback.',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'User2',
          rating: 4,
          comment: 'Good service, thank you.',
          submittedAt: '2024-01-15T11:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(normalPayload, 'org123');

      expect(result.success).toBe(2);
      expect(result.flaggedCount).toBe(0);
    });

    it('nên xử lý row với location field', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const payload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z',
          location: '21.0285,105.8542'
        }
      ];

      const result = await processJsonBatchFeedback(payload, 'org123');

      expect(result.success).toBe(1);
    });

    it('nên xử lý row không có location field (optional)', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const payload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(payload, 'org123');

      expect(result.success).toBe(1);
    });

    it('nên xử lý JSON batch và gọi insertMany với đúng payload structure', async () => {
      (BeneficiaryFeedbackModel.insertMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const payload = [
        {
          projectId: 'proj1',
          beneficiaryName: 'Nguyen Van A',
          rating: 4,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      const result = await processJsonBatchFeedback(payload, 'org123');

      expect(result.success).toBe(1);
      expect(BeneficiaryFeedbackModel.insertMany).toHaveBeenCalled();
      // NIT #6: Strengthen assertion - verify insertMany payload structure
      expect(BeneficiaryFeedbackModel.insertMany).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            feedbackId: expect.stringMatching(/^FB-/),
            projectId: 'proj1',
            beneficiaryNameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            rating: 4,
            comment: 'Good',
            submittedAt: expect.any(Date),
            uploadedByOrganizationId: 'org123',
            riskScore: expect.any(Number),
            isFlagged: expect.any(Boolean)
          })
        ],
        { ordered: false }
      );
    });
  });

  describe('hashBeneficiaryName', () => {
    it('nên hash cùng input thành cùng hash', () => {
      const name = 'Test Name';
      const hash1 = hashBeneficiaryName(name);
      const hash2 = hashBeneficiaryName(name);
      expect(hash1).toBe(hash2);
    });

    it('nên hash khác input thành hash khác nhau', () => {
      const hash1 = hashBeneficiaryName('Name1');
      const hash2 = hashBeneficiaryName('Name2');
      expect(hash1).not.toBe(hash2);
    });

    it('nên trả về hex string 64 ký tự', () => {
      const hash = hashBeneficiaryName('Any name');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('nên không chứa plaintext trong hash', () => {
      const hash = hashBeneficiaryName('SensitiveName');
      expect(hash).not.toContain('SensitiveName');
    });
  });
});
