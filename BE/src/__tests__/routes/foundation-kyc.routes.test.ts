import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateRateLimitMiddleware,
  mockVerifyRecaptchaToken,
  mockSubmitFoundationKyc,
  mockCountAgainstLimit,
  mockGetPublicFeedbackClientIp
} = vi.hoisted(() => ({
  mockCreateRateLimitMiddleware: vi.fn(),
  mockVerifyRecaptchaToken: vi.fn(),
  mockSubmitFoundationKyc: vi.fn(),
  mockCountAgainstLimit: vi.fn(),
  mockGetPublicFeedbackClientIp: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

vi.mock('../../middleware/rateLimitMiddleware', () => ({
  createRateLimitMiddleware: mockCreateRateLimitMiddleware
}));

vi.mock('../../services/recaptcha.service', () => ({
  verifyRecaptchaToken: mockVerifyRecaptchaToken
}));

vi.mock('../../services/foundationKyc.service', () => ({
  submitFoundationKyc: mockSubmitFoundationKyc
}));

vi.mock('../../utils/submissionThrottle', () => ({
  countAgainstLimit: mockCountAgainstLimit,
  SubmissionThrottleCapacityError: class SubmissionThrottleCapacityError extends Error {}
}));

vi.mock('../../utils/publicFeedbackClientIdentity', () => ({
  getPublicFeedbackClientIp: mockGetPublicFeedbackClientIp
}));

vi.mock('../../config/foundationKycRuntimeConfig', () => ({
  getFoundationKycIpHashSalt: vi.fn(() => 'test-salt')
}));

import { createFoundationKycRoutes } from '../../routes/foundation-kyc.routes';

/** Tạo payload hợp lệ dùng chung cho contract test route public. */
function createValidFoundationPayload(additionalEmail = ''): Record<string, unknown> {
  return {
    organizationName: 'Quỹ An Tâm',
    legalRegistrationNumber: 'ABC-12345',
    taxIdentificationNumber: '0101234567',
    officialWebsite: 'https://example.org',
    organizationDescription: 'Quỹ hỗ trợ cộng đồng trong các chương trình an sinh.',
    legalDocument: {
      fileName: 'license.pdf',
      mimeType: 'application/pdf',
      base64Content: 'JVBERi0xLjQK'
    },
    bankName: 'MB',
    bankAccountNumber: '1234567890',
    accountHolderName: 'QUY AN TAM',
    branchName: 'Ha Noi',
    recaptchaToken: 'recaptcha-token',
    additionalEmail
  };
}

/** Dựng app Express tối thiểu để xác nhận route không gắn authentication middleware. */
function createTestApplication(): express.Application {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use('/api/foundation-kyc', createFoundationKycRoutes());
  return testApplication;
}

describe('foundation KYC public routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRateLimitMiddleware.mockImplementation(() => (_request: express.Request, _response: express.Response, next: express.NextFunction) => next());
    mockGetPublicFeedbackClientIp.mockReturnValue('203.0.113.10');
    mockVerifyRecaptchaToken.mockResolvedValue({ isVerified: true, score: 0.9 });
    mockCountAgainstLimit.mockResolvedValue(true);
    mockSubmitFoundationKyc.mockResolvedValue({ submissionId: 'foundation-001', version: 1, status: 'PENDING_REVIEW' });
  });

  it('configures the required 3-per-minute limiter and accepts honeypot without auth', async () => {
    const response = await request(createTestApplication())
      .post('/api/foundation-kyc/submit')
      .send(createValidFoundationPayload('bot@example.com'));

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ submissionId: null, version: 0, status: 'PENDING_REVIEW' });
    expect(mockVerifyRecaptchaToken).not.toHaveBeenCalled();
    expect(mockSubmitFoundationKyc).not.toHaveBeenCalled();
    expect(mockCreateRateLimitMiddleware).toHaveBeenCalledWith(3, 60_000, expect.objectContaining({
      bucketName: 'foundation-kyc:submit',
      clientIpResolver: mockGetPublicFeedbackClientIp
    }));
  });

  it('verifies captcha, applies the daily quota and submits a legitimate payload', async () => {
    const response = await request(createTestApplication())
      .post('/api/foundation-kyc/submit')
      .send(createValidFoundationPayload());

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ submissionId: 'foundation-001', version: 1, status: 'PENDING_REVIEW' });
    expect(mockVerifyRecaptchaToken).toHaveBeenCalledWith('recaptcha-token', 'foundation_kyc_submit', '203.0.113.10');
    expect(mockCountAgainstLimit).toHaveBeenCalledWith(expect.stringContaining('dcp:foundation-kyc:ip:'), 5, 86400);
    expect(mockSubmitFoundationKyc).toHaveBeenCalledWith(expect.objectContaining({
      organizationName: 'Quỹ An Tâm'
    }), expect.objectContaining({ clientIpHash: expect.any(String) }));
  });

  it('returns CAPTCHA_FAILED before any quota or upload work when captcha is rejected', async () => {
    mockVerifyRecaptchaToken.mockResolvedValue({ isVerified: false, reason: 'LOW_SCORE' });

    const response = await request(createTestApplication())
      .post('/api/foundation-kyc/submit')
      .send(createValidFoundationPayload());

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe('CAPTCHA_FAILED');
    expect(mockCountAgainstLimit).not.toHaveBeenCalled();
    expect(mockSubmitFoundationKyc).not.toHaveBeenCalled();
  });

  it('rejects a bank outside the PayOS-linked business bank list at the HTTP boundary', async () => {
    const response = await request(createTestApplication())
      .post('/api/foundation-kyc/submit')
      .send({ ...createValidFoundationPayload(), bankName: 'Vietcombank' });

    expect(response.status).toBe(400);
    expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    expect(mockVerifyRecaptchaToken).not.toHaveBeenCalled();
    expect(mockSubmitFoundationKyc).not.toHaveBeenCalled();
  });

  it('rejects an invalid tax identification number at the HTTP boundary', async () => {
    const response = await request(createTestApplication())
      .post('/api/foundation-kyc/submit')
      .send({ ...createValidFoundationPayload(), taxIdentificationNumber: '12345' });

    expect(response.status).toBe(400);
    expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    expect(mockVerifyRecaptchaToken).not.toHaveBeenCalled();
    expect(mockSubmitFoundationKyc).not.toHaveBeenCalled();
  });
});
