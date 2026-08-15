import { describe, expect, it } from 'vitest';
import {
  feedbackDeleteBodySchema,
  flaggedFeedbackListQuerySchema
} from '../../validators/flaggedFeedback.validator';

describe('flaggedFeedback validators', () => {
  it('áp dụng default pagination và chấp nhận filter hợp lệ ở các biên', () => {
    expect(flaggedFeedbackListQuerySchema.parse({})).toMatchObject({
      page: 1,
      limit: 20,
      deletionState: 'active'
    });
    expect(flaggedFeedbackListQuerySchema.parse({
      page: '10000',
      limit: '100',
      deletionState: 'deleted',
      projectId: 'DA-2026_001',
      minRiskScore: '0',
      source: 'public'
    })).toMatchObject({
      page: 10000,
      limit: 100,
      deletionState: 'deleted',
      projectId: 'DA-2026_001',
      minRiskScore: 0,
      source: 'public'
    });
  });

  it('từ chối page/limit/filter nằm ngoài contract', () => {
    expect(flaggedFeedbackListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(flaggedFeedbackListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(flaggedFeedbackListQuerySchema.safeParse({ deletionState: 'unknown' }).success).toBe(false);
    expect(flaggedFeedbackListQuerySchema.safeParse({ source: 'import' }).success).toBe(false);
    expect(flaggedFeedbackListQuerySchema.safeParse({ projectId: 'bad/project' }).success).toBe(false);
    expect(flaggedFeedbackListQuerySchema.safeParse({ minRiskScore: 11 }).success).toBe(false);
  });

  it('normalize reason trước khi kiểm tra biên 10–1000 ký tự', () => {
    expect(feedbackDeleteBodySchema.parse({ reason: '  đủ   lý do hợp lệ  ' }).reason).toBe('đủ lý do hợp lệ');
    expect(feedbackDeleteBodySchema.safeParse({ reason: '123456789' }).success).toBe(false);
    expect(feedbackDeleteBodySchema.safeParse({ reason: '1234567890' }).success).toBe(true);
    expect(feedbackDeleteBodySchema.safeParse({ reason: 'a'.repeat(1000) }).success).toBe(true);
    expect(feedbackDeleteBodySchema.safeParse({ reason: 'a'.repeat(1001) }).success).toBe(false);
  });
});
