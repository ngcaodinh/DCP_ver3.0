import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

const { mockModerate } = vi.hoisted(() => ({
  mockModerate: vi.fn()
}));

vi.mock('../../services/feedbackModeration.service', () => ({
  moderateBeneficiaryFeedback: mockModerate
}));

import { handleFeedbackModeration } from '../../controllers/feedbackModerationController';

/** Tạo request có user admin giả lập để kiểm tra response moderation qua HTTP. */
function createTestApplication(): express.Application {
  const application = express();
  application.use(express.json());
  application.post('/:action/:feedbackId', (request, response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    authenticatedRequest.authenticatedUser = { userId: 'admin-1', role: 'admin' };
    return handleFeedbackModeration(authenticatedRequest, response);
  });
  return application;
}

describe('feedbackModerationController', () => {
  it('does not expose internal hashes in the moderation response', async () => {
    mockModerate.mockResolvedValue({
      feedbackId: 'FB-1',
      isFlagged: true,
      submissionIpHash: 'internal-only',
      beneficiaryNameHash: 'internal-only'
    });

    const response = await request(createTestApplication())
      .post('/flag/FB-1')
      .send({ reason: 'Nội dung cần kiểm duyệt' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ feedbackId: 'FB-1', isFlagged: true });
    expect(response.body.data).not.toHaveProperty('submissionIpHash');
    expect(response.body.data).not.toHaveProperty('beneficiaryNameHash');
  });
});
