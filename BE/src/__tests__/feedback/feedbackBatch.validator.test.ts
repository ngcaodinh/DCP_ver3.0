/**
 * Test cho feedbackBatchValidator.ts - kiểm tra Zod schemas và validation logic.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFeedbackRow,
  validateBatchFeedback,
  beneficiaryFeedbackRowSchema
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
  });
});
