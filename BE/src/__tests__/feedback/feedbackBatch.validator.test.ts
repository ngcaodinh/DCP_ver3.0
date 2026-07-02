/**
 * Test cho feedbackBatchValidator.ts - kiểm tra Zod schemas và validation logic.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFeedbackRow,
  validateBatchFeedback,
  beneficiaryFeedbackRowSchema,
  batchFeedbackJsonSchema
} from '../../validators/feedbackBatchValidator';

describe('feedbackBatchValidator', () => {
  describe('validateFeedbackRow', () => {
    it('nên validate valid feedback row thành công', () => {
      const validRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 5,
        comment: 'Great service!',
        submittedAt: '2024-01-15T10:00:00Z',
        location: 'Hanoi'
      };

      const result = validateFeedbackRow(validRow, 1);

      expect(result.isValid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.projectId).toBe('proj123');
      expect(result.errors).toBeUndefined();
    });

    it('nên validate row không có location (optional)', () => {
      const validRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(validRow, 1);
      expect(result.isValid).toBe(true);
    });

    it('nên reject row thiếu projectId', () => {
      const invalidRow = {
        beneficiaryName: 'Nguyen Van A',
        rating: 5,
        comment: 'Great!',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);

      expect(result.isValid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some(e => e.field === 'projectId')).toBe(true);
    });

    it('nên reject row với rating ngoài khoảng 1-5', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 6,
        comment: 'Great!',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);

      expect(result.isValid).toBe(false);
      expect(result.errors?.some(e => e.message.includes('1-5'))).toBe(true);
    });

    it('nên reject row với rating = 0', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 0,
        comment: 'Bad',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với rating không phải số nguyên', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 3.5,
        comment: 'OK',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với submittedAt không đúng format', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 5,
        comment: 'Great!',
        submittedAt: '2024-01-15' // Thiếu timezone
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với empty comment', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 5,
        comment: '   ',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với projectId chỉ có whitespace', () => {
      const invalidRow = {
        projectId: '   ',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
      expect(result.errors?.some(e => e.field === 'projectId')).toBe(true);
    });

    it('nên reject row với beneficiaryName chỉ có whitespace', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: '   ',
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
      expect(result.errors?.some(e => e.field === 'beneficiaryName')).toBe(true);
    });

    it('nên pass với beneficiaryName chứa ký tự đặc biệt', () => {
      const validRow = {
        projectId: 'proj123',
        beneficiaryName: "O'Brien-Smith Jr.",
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(validRow, 1);
      expect(result.isValid).toBe(true);
    });

    it('nên reject row với rating = -1', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: -1,
        comment: 'Bad',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
      expect(result.errors?.some(e => e.message.includes('1-5'))).toBe(true);
    });

    it('nên reject row với rating là string', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 'abc',
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
      expect(result.errors?.some(e => e.field === 'rating')).toBe(true);
    });

    it('nên reject row với rating là null', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: null,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với rating là undefined', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: undefined,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với submittedAt là timestamp number', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: 1705312800000
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với submittedAt không hợp lệ (random string)', () => {
      const invalidRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: 'not-a-date'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
    });

    it('nên pass với submittedAt là valid ISO datetime', () => {
      const validRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00.000Z'
      };

      const result = validateFeedbackRow(validRow, 1);
      expect(result.isValid).toBe(true);
    });

    it('nên pass với location chứa coordinates string', () => {
      const validRow = {
        projectId: 'proj123',
        beneficiaryName: 'Nguyen Van A',
        rating: 4,
        comment: 'Good',
        submittedAt: '2024-01-15T10:00:00Z',
        location: '21.0285,105.8542'
      };

      const result = validateFeedbackRow(validRow, 1);
      expect(result.isValid).toBe(true);
    });

    it('nên validate rowNumber chính xác trong error result', () => {
      const invalidRow = {
        beneficiaryName: 'Nguyen Van A',
        rating: 5,
        comment: 'Great!',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = validateFeedbackRow(invalidRow, 5);
      expect(result.rowNumber).toBe(5);
      expect(result.isValid).toBe(false);
    });

    it('nên reject row với nhiều field thiếu cùng lúc', () => {
      const invalidRow = {
        someField: 'value'
      };

      const result = validateFeedbackRow(invalidRow, 1);
      expect(result.isValid).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(1);
    });
  });

  describe('validateBatchFeedback', () => {
    it('nên validate batch với mix valid và invalid rows', () => {
      const rows = [
        {
          projectId: 'proj1',
          beneficiaryName: 'A',
          rating: 5,
          comment: 'Good',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'B',
          rating: 10, // Invalid
          comment: 'OK',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj3',
          beneficiaryName: 'C',
          rating: 3,
          comment: 'Nice',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      const result = validateBatchFeedback(rows);

      expect(result.totalRows).toBe(3);
      expect(result.validRows).toHaveLength(2);
      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].rowNumber).toBe(2);
    });

    it('nên trả về empty arrays cho empty input', () => {
      const result = validateBatchFeedback([]);

      expect(result.totalRows).toBe(0);
      expect(result.validRows).toHaveLength(0);
      expect(result.invalidRows).toHaveLength(0);
    });

    it('nên validate rating boundary values (1 và 5)', () => {
      const rows = [
        {
          projectId: 'proj1',
          beneficiaryName: 'A',
          rating: 1,
          comment: 'Bad',
          submittedAt: '2024-01-15T10:00:00Z'
        },
        {
          projectId: 'proj2',
          beneficiaryName: 'B',
          rating: 5,
          comment: 'Excellent',
          submittedAt: '2024-01-15T10:00:00Z'
        }
      ];

      const result = validateBatchFeedback(rows);
      expect(result.validRows).toHaveLength(2);
    });

    it('nên validate rowNumber chính xác cho mỗi row trong batch', () => {
      const rows = [
        { projectId: 'p1', beneficiaryName: 'A', rating: 1, comment: 'C1', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p2', beneficiaryName: 'B', rating: 2, comment: 'C2', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p3', beneficiaryName: 'C', rating: 3, comment: 'C3', submittedAt: '2024-01-15T10:00:00Z' }
      ];

      const result = validateBatchFeedback(rows);

      expect(result.validRows[0].rowNumber).toBe(1);
      expect(result.validRows[1].rowNumber).toBe(2);
      expect(result.validRows[2].rowNumber).toBe(3);
    });

    it('nên trả về correct rowNumber trong errors array khi row invalid', () => {
      const rows = [
        { projectId: 'p1', beneficiaryName: 'A', rating: 1, comment: 'C1', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p2', beneficiaryName: 'B', rating: 99, comment: 'C2', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p3', beneficiaryName: 'C', rating: 3, comment: 'C3', submittedAt: '2024-01-15T10:00:00Z' }
      ];

      const result = validateBatchFeedback(rows);

      expect(result.invalidRows[0].rowNumber).toBe(2);
      expect(result.validRows[0].rowNumber).toBe(1);
      expect(result.validRows[1].rowNumber).toBe(3);
    });

    it('nên validate tất cả rows ngay cả khi có nhiều invalid rows', () => {
      const rows = [
        { projectId: 'p1', beneficiaryName: 'A', rating: 1, comment: 'C1', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: '', beneficiaryName: 'B', rating: 2, comment: 'C2', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p3', beneficiaryName: '', rating: 3, comment: 'C3', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p4', beneficiaryName: 'D', rating: 99, comment: 'C4', submittedAt: '2024-01-15T10:00:00Z' },
        { projectId: 'p5', beneficiaryName: 'E', rating: 5, comment: 'C5', submittedAt: '2024-01-15T10:00:00Z' }
      ];

      const result = validateBatchFeedback(rows);

      expect(result.totalRows).toBe(5);
      expect(result.validRows).toHaveLength(2);
      expect(result.invalidRows).toHaveLength(3);
    });
  });

  describe('beneficiaryFeedbackRowSchema', () => {
    it('nên parse successfully với valid data', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00.000Z',
        location: 'Test Location'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('nên reject khi projectId là empty string', () => {
      const data = {
        projectId: '',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên reject khi beneficiaryName là empty string', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: '',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên reject khi rating không phải integer', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 3.5,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success && result.error.issues[0]) {
        expect(result.error.issues[0].message).toContain('số nguyên');
      }
    });

    it('nên reject khi comment là empty string', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: '',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên reject khi submittedAt không đúng ISO format', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên accept khi location là undefined (optional field)', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00Z'
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('nên accept khi location là empty string', () => {
      const data = {
        projectId: 'proj123',
        beneficiaryName: 'Test User',
        rating: 4,
        comment: 'Test comment',
        submittedAt: '2024-01-15T10:00:00Z',
        location: ''
      };

      const result = beneficiaryFeedbackRowSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe('batchFeedbackJsonSchema', () => {
    it('nên reject empty feedbacks array', () => {
      const data = { feedbacks: [] };
      const result = batchFeedbackJsonSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên reject feedbacks array với hơn 1000 items', () => {
      const feedbacks = Array.from({ length: 1001 }, (_, i) => ({
        projectId: `proj${i}`,
        beneficiaryName: `User${i}`,
        rating: 4,
        comment: `Comment ${i}`,
        submittedAt: '2024-01-15T10:00:00Z'
      }));
      const data = { feedbacks };
      const result = batchFeedbackJsonSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('nên accept feedbacks array với đúng 1000 items', () => {
      const feedbacks = Array.from({ length: 1000 }, (_, i) => ({
        projectId: `proj${i}`,
        beneficiaryName: `User${i}`,
        rating: 4,
        comment: `Comment ${i}`,
        submittedAt: '2024-01-15T10:00:00Z'
      }));
      const data = { feedbacks };
      const result = batchFeedbackJsonSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});
