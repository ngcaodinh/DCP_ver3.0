import { describe, expect, it } from 'vitest';
import { publicFeedbackSubmitSchema } from '../../validators/publicFeedbackSubmitValidator';

describe('publicFeedbackSubmitValidator', () => {
  it('coerce rating từ form string và trim các trường text', () => {
    const result = publicFeedbackSubmitSchema.safeParse({
      projectId: '  project-001 ',
      rating: '5',
      comment: '  Phản hồi hợp lệ  ',
      anonymousName: '  Người dùng  ',
      submissionTicket: 'ticket',
      redirect: '1'
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rating).toBe(5);
      expect(result.data.projectId).toBe('project-001');
      expect(result.data.comment).toBe('Phản hồi hợp lệ');
      expect(result.data.anonymousName).toBe('Người dùng');
    }
  });

  it.each([
    ['missing ticket', { projectId: 'project-001', rating: '4', comment: 'Nội dung hợp lệ' }],
    ['invalid projectId', { projectId: '../secret', rating: '4', comment: 'Nội dung hợp lệ', submissionTicket: 'ticket' }],
    ['empty comment', { projectId: 'project-001', rating: '4', comment: '   ', submissionTicket: 'ticket' }],
    ['comment too long', { projectId: 'project-001', rating: '4', comment: 'x'.repeat(1001), submissionTicket: 'ticket' }]
  ])('rejects %s at the API boundary', (_caseName, payload) => {
    expect(publicFeedbackSubmitSchema.safeParse(payload).success).toBe(false);
  });
});
