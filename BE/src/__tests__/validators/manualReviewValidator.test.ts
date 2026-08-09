import { describe, expect, it } from 'vitest';
import {
  manualReviewDetailQuerySchema,
  manualReviewPendingQuerySchema,
  manualReviewRejectBodySchema
} from '../../validators/manualReviewValidator';

describe('manualReviewValidator', () => {
  it('áp dụng default và clamp pagination, đồng thời giữ filter optional backward-compatible', () => {
    expect(manualReviewPendingQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 50,
      overdueOnly: false
    });
    expect(manualReviewPendingQuerySchema.parse({ page: '2', limit: '51', overdueOnly: 'true', requestMode: 'EMERGENCY' })).toEqual({
      page: 2,
      limit: 50,
      overdueOnly: true,
      requestMode: 'EMERGENCY'
    });
  });

  it.each([
    { page: '0' },
    { limit: '0' },
    { overdueOnly: 'yes' },
    { requestMode: 'URGENT' }
  ])('từ chối pending query không hợp lệ: $page $limit $overdueOnly $requestMode', (query) => {
    expect(manualReviewPendingQuerySchema.safeParse(query).success).toBe(false);
  });

  it('validate revealBankAccount với default false và reject giá trị ngoài enum', () => {
    expect(manualReviewDetailQuerySchema.parse({})).toEqual({ revealBankAccount: false });
    expect(manualReviewDetailQuerySchema.parse({ revealBankAccount: 'true' })).toEqual({ revealBankAccount: true });
    expect(manualReviewDetailQuerySchema.safeParse({ revealBankAccount: '1' }).success).toBe(false);
  });

  it.each([
    { reason: '123456789' },
    { reason: 'x'.repeat(1001) }
  ])('từ chối reason ngoài biên 10–1000 ký tự', ({ reason }) => {
    expect(manualReviewRejectBodySchema.safeParse({ reason }).success).toBe(false);
  });

  it('chấp nhận reason đúng biên và trim trước khi truyền vào service', () => {
    expect(manualReviewRejectBodySchema.parse({ reason: '  1234567890  ' })).toEqual({ reason: '1234567890' });
    expect(manualReviewRejectBodySchema.parse({ reason: 'x'.repeat(1000) }).reason).toHaveLength(1000);
  });
});
