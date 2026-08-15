import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../../utils/applicationError';

const { mockGetContext, mockSubmit } = vi.hoisted(() => ({
  mockGetContext: vi.fn(),
  mockSubmit: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: () => (_request: express.Request, _response: express.Response, next: express.NextFunction) => next()
}));

vi.mock('../../services/publicFeedbackSubmit.service', () => ({
  getPublicFeedbackFormContext: mockGetContext,
  submitSingleFeedback: mockSubmit
}));

import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';

/** Tạo Express app tối giản để test contract route mà không cần boot toàn hệ thống. */
function createTestApplication(): express.Application {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use(express.urlencoded({ extended: true }));
  testApplication.use('/api/feedback', createPublicFeedbackRoutes());
  return testApplication;
}

describe('public feedback submit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'http://localhost:3000';
  });

  it('returns form context and a submission ticket', async () => {
    mockGetContext.mockResolvedValue({
      projectId: 'project-001',
      projectName: 'Dự án hỗ trợ',
      isAcceptingFeedback: true,
      submissionTicket: 'ticket-001'
    });

    const response = await request(createTestApplication()).get('/api/feedback/form-context/project-001');

    expect(response.status).toBe(200);
    expect(response.body.data.submissionTicket).toBe('ticket-001');
  });

  it.each([
    ['ACTIVE', true],
    ['COMPLETED', true],
    ['CLOSED', true],
    ['DRAFT', false],
    ['PENDING_APPROVAL', false],
    ['REJECTED', false]
  ] as const)('serializes form context for %s without leaking a ticket when closed', async (_status, isAcceptingFeedback) => {
    mockGetContext.mockResolvedValue({
      projectId: 'project-001',
      projectName: 'Dự án hỗ trợ',
      isAcceptingFeedback,
      ...(isAcceptingFeedback ? { submissionTicket: 'ticket-001' } : {})
    });

    const response = await request(createTestApplication()).get('/api/feedback/form-context/project-001');

    expect(response.status).toBe(200);
    expect(response.body.data.isAcceptingFeedback).toBe(isAcceptingFeedback);
    expect(response.body.data).toHaveProperty(
      isAcceptingFeedback ? 'submissionTicket' : 'projectName'
    );
    if (!isAcceptingFeedback) expect(response.body.data).not.toHaveProperty('submissionTicket');
  });

  it('maps a missing project to a stable 404 contract', async () => {
    mockGetContext.mockRejectedValue(new ApplicationError('Dự án không tồn tại.', 404, 'PROJECT_NOT_FOUND'));

    const response = await request(createTestApplication()).get('/api/feedback/form-context/missing-project');

    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe('PROJECT_NOT_FOUND');
  });

  it('rejects a direct POST without a ticket before reaching the service', async () => {
    const response = await request(createTestApplication())
      .post('/api/feedback/single')
      .send({ projectId: 'project-001', rating: '5', comment: 'Nội dung hợp lệ' });

    expect(response.status).toBe(400);
    expect(response.body.errorCode).toBe('INVALID_TICKET');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('returns a neutral success for honeypot submissions without calling the service', async () => {
    const response = await request(createTestApplication())
      .post('/api/feedback/single')
      .send({
        projectId: 'project-001',
        rating: '5',
        comment: 'Nội dung hợp lệ',
        submissionTicket: 'ticket-001',
        contactEmail: 'bot@example.com'
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ feedbackId: null, isFlagged: false });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('redirects browser form submissions to the status page', async () => {
    mockSubmit.mockResolvedValue({
      feedbackId: 'FB-1',
      isFlagged: true,
      submissionIpHash: 'internal-only'
    });

    const response = await request(createTestApplication())
      .post('/api/feedback/single')
      .set('Accept', 'text/html')
      .send({
        projectId: 'project-001',
        rating: '5',
        comment: 'Nội dung feedback đủ dài để gửi',
        submissionTicket: 'ticket-001'
      });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('http://localhost:3000/feedback/project-001?status=success');
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ rating: 5 }), expect.any(String));
  });

  it('does not expose internal submission IP hashes in the JSON response', async () => {
    mockSubmit.mockResolvedValue({
      feedbackId: 'FB-2',
      isFlagged: false,
      submissionIpHash: 'internal-only'
    });

    const response = await request(createTestApplication())
      .post('/api/feedback/single')
      .send({
        projectId: 'project-001',
        rating: '5',
        comment: 'Nội dung feedback đủ dài để gửi',
        submissionTicket: 'ticket-001'
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ feedbackId: 'FB-2', isFlagged: false });
    expect(response.body.data).not.toHaveProperty('submissionIpHash');
  });
});
