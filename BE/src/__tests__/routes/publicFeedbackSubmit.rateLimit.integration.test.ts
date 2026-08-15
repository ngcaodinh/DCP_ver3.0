import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindFeedbackProjectByProjectId,
  mockCreate,
  mockVerifySubmissionTicket,
  mockInvalidateStats
} = vi.hoisted(() => ({
  mockFindFeedbackProjectByProjectId: vi.fn(),
  mockCreate: vi.fn(),
  mockVerifySubmissionTicket: vi.fn(),
  mockInvalidateStats: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

vi.mock('../../models/projectModel', () => ({
  findFeedbackProjectByProjectId: mockFindFeedbackProjectByProjectId
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: { create: mockCreate }
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../utils/feedbackSubmissionTicket', () => ({
  TICKET_TTL_SECONDS: 1800,
  issueSubmissionTicket: vi.fn(),
  verifySubmissionTicket: mockVerifySubmissionTicket
}));

vi.mock('../../services/feedbackSpamDetection.service', () => ({
  computeRiskScore: vi.fn(() => 0),
  shouldFlagFeedback: vi.fn(() => false)
}));

vi.mock('../../services/publicFeedback.service', () => ({
  getPublicFeedbackList: vi.fn(),
  getPublicFeedbackStats: vi.fn(),
  invalidatePublicFeedbackStatsCache: mockInvalidateStats
}));

import { createPublicFeedbackRoutes } from '../../routes/public-feedback.routes';
import {
  createPublicFeedbackClientIpSignature,
  PUBLIC_FEEDBACK_CLIENT_IP_HEADER,
  PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER
} from '../../utils/publicFeedbackClientIdentity';
import { __resetPublicFeedbackClientIpHmacKeyCacheForTests } from '../../config/publicFeedbackRuntimeConfig';
import { __resetSubmissionThrottleState } from '../../utils/submissionThrottle';

/** Tạo app integration có trust proxy giống production để kiểm chứng X-Forwarded-For. */
function createTestApplication(): express.Application {
  const testApplication = express();
  testApplication.set('trust proxy', 1);
  testApplication.use(express.json());
  testApplication.use(express.urlencoded({ extended: false }));
  testApplication.use('/api/feedback', createPublicFeedbackRoutes());
  return testApplication;
}

describe('public feedback submit rate-limit integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSubmissionThrottleState();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_IP_HASH_SALT', 'route-test-salt');
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', 'route-test-client-ip-hmac-key');
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
    mockFindFeedbackProjectByProjectId.mockResolvedValue({
      projectId: 'project-001',
      organizationId: 'org-001',
      name: 'Dự án hỗ trợ',
      status: 'ACTIVE'
    });
    mockCreate.mockResolvedValue({});
    mockVerifySubmissionTicket.mockImplementation((ticket: string) => ({
      projectId: 'project-001',
      issuedAt: Date.now(),
      nonce: ticket
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetPublicFeedbackClientIpHmacKeyCacheForTests();
  });

  it('cho phép 40 người cùng NAT gửi nội dung và ticket khác nhau trong một phút', async () => {
    const testApplication = createTestApplication();

    for (let index = 0; index < 40; index += 1) {
      const response = await request(testApplication)
        .post('/api/feedback/single')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({
          projectId: 'project-001',
          rating: 4,
          comment: `Nội dung riêng biệt của người dùng số ${index} trong cuộc họp cộng đồng.`,
          anonymousName: `Người dùng ${index}`,
          submissionTicket: `ticket-${index}`
        });

      expect(response.status).toBe(201);
    }

    expect(mockCreate).toHaveBeenCalledTimes(40);
  });

  it('cho phép 40 lượt form-context và 40 lượt stats cùng NAT trong một phút', async () => {
    const testApplication = createTestApplication();
    const clientIp = '203.0.113.10';
    const signedHeaders = {
      [PUBLIC_FEEDBACK_CLIENT_IP_HEADER]: clientIp,
      [PUBLIC_FEEDBACK_CLIENT_IP_SIGNATURE_HEADER]: createPublicFeedbackClientIpSignature(clientIp)
    };

    for (let index = 0; index < 40; index += 1) {
      const formContextResponse = await request(testApplication)
        .get('/api/feedback/form-context/project-001')
        .set(signedHeaders);
      const statsResponse = await request(testApplication)
        .get('/api/feedback/stats/project-001')
        .set(signedHeaders);

      expect(formContextResponse.status).not.toBe(429);
      expect(statsResponse.status).not.toBe(429);
    }
  });
});
