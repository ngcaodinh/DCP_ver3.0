import { describe, expect, it } from 'vitest';
import { organizationFeedbackListQuerySchema } from '../../validators/organizationFeedback.validator';

describe('organizationFeedback.validator', () => {
  it('dùng default page, limit và moderationState khi query rỗng', () => {
    expect(organizationFeedbackListQuerySchema.parse({})).toEqual({ page: 1, limit: 20, moderationState: 'all' });
  });

  it('chấp nhận biên hợp lệ và bỏ qua query array bằng giá trị đầu tiên', () => {
    expect(organizationFeedbackListQuerySchema.parse({
      page: ['2', '3'],
      limit: '100',
      projectId: 'DA-2026_001',
      source: 'batch',
      moderationState: 'pending'
    })).toEqual({ page: 2, limit: 100, projectId: 'DA-2026_001', source: 'batch', moderationState: 'pending' });
  });

  it('chấp nhận đúng các boundary page/limit và projectId dài tối đa', () => {
    const result = organizationFeedbackListQuerySchema.parse({
      page: '10000',
      limit: '1',
      projectId: 'A'.repeat(64),
      source: 'public',
      moderationState: 'visible'
    });

    expect(result).toEqual({
      page: 10000,
      limit: 1,
      projectId: 'A'.repeat(64),
      source: 'public',
      moderationState: 'visible'
    });
  });

  it.each([
    { limit: '101' },
    { page: '0' },
    { page: '10001' },
    { limit: '0' },
    { page: '1.5' },
    { limit: 'abc' },
    { moderationState: 'unknown' },
    { source: 'internal' },
    { projectId: 'DA 001' },
    { projectId: 'A'.repeat(65) },
    { projectId: 'DA/001' },
    { projectId: '' }
  ])('từ chối query không hợp lệ: %o', query => {
    expect(organizationFeedbackListQuerySchema.safeParse(query).success).toBe(false);
  });
});
