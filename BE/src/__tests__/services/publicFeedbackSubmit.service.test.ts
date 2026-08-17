import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';
import type { PublicFeedbackSubmitPayload } from '../../validators/publicFeedbackSubmitValidator';

const {
  mockFindFeedbackProjectByProjectId,
  mockCreate,
  mockClaimOnce,
  mockReleaseSubmissionSlot,
  mockCountAgainstLimit,
  mockInvalidateStats,
  mockVerifyTicket,
  mockHashBeneficiaryName,
  mockComputeRiskScore,
  mockShouldFlagFeedback
} = vi.hoisted(() => ({
  mockFindFeedbackProjectByProjectId: vi.fn(),
  mockCreate: vi.fn(),
  mockClaimOnce: vi.fn(),
  mockReleaseSubmissionSlot: vi.fn().mockResolvedValue(undefined),
  mockCountAgainstLimit: vi.fn().mockResolvedValue(true),
  mockInvalidateStats: vi.fn(),
  mockVerifyTicket: vi.fn<(ticket: string) => { projectId: string; issuedAt: number; nonce: string }>(() => ({
    projectId: 'project-001',
    issuedAt: Date.now(),
    nonce: 'nonce-001'
  })),
  mockHashBeneficiaryName: vi.fn((value: string) => crypto.createHash('sha256').update(value).digest('hex')),
  mockComputeRiskScore: vi.fn(() => 0),
  mockShouldFlagFeedback: vi.fn(() => false)
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

vi.mock('../../utils/submissionThrottle', () => ({
  SubmissionThrottleCapacityError: class SubmissionThrottleCapacityError extends Error {},
  claimOnce: mockClaimOnce,
  releaseSubmissionSlot: mockReleaseSubmissionSlot,
  countAgainstLimit: mockCountAgainstLimit
}));

vi.mock('../../utils/feedbackSubmissionTicket', () => ({
  TICKET_TTL_SECONDS: 1800,
  verifySubmissionTicket: mockVerifyTicket,
  issueSubmissionTicket: vi.fn(() => 'ticket')
}));

vi.mock('../../utils/feedbackText', () => ({
  hashBeneficiaryName: mockHashBeneficiaryName
}));

vi.mock('../../services/feedbackSpamDetection.service', () => ({
  computeRiskScore: mockComputeRiskScore,
  shouldFlagFeedback: mockShouldFlagFeedback
}));

vi.mock('../../services/publicFeedback.service', () => ({
  invalidatePublicFeedbackStatsCache: mockInvalidateStats
}));

vi.mock('../../services/event-logger.service', () => ({
  logEvent: vi.fn()
}));

import {
  getPublicFeedbackFormContext,
  submitSingleFeedback
} from '../../services/publicFeedbackSubmit.service';
import { logEvent } from '../../services/event-logger.service';

const project = {
  projectId: 'project-001',
  organizationId: 'org-001',
  name: 'Dự án hỗ trợ',
  status: 'ACTIVE'
} as ProjectRecord;

/** Tạo payload public hợp lệ làm nền cho các kịch bản service. */
function createPayload(overrides: Partial<PublicFeedbackSubmitPayload> = {}): PublicFeedbackSubmitPayload {
  return {
    projectId: 'project-001',
    rating: 4,
    comment: 'Nội dung feedback đủ dài để kiểm thử duplicate.',
    anonymousName: 'Người gửi',
    submissionTicket: 'ticket-001',
    redirect: '1',
    ...overrides
  };
}

describe('publicFeedbackSubmit.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_IP_HASH_SALT', 'test-salt');
    mockFindFeedbackProjectByProjectId.mockResolvedValue(project);
    mockCreate.mockResolvedValue({});
    mockClaimOnce.mockResolvedValue(true);
    mockCountAgainstLimit.mockResolvedValue(true);
    mockVerifyTicket.mockReturnValue({ projectId: 'project-001', issuedAt: Date.now(), nonce: 'nonce-001' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('creates a public feedback with server timestamp, source and salted IP hash', async () => {
    const result = await submitSingleFeedback(createPayload(), '203.0.113.10');
    const savedDocument = mockCreate.mock.calls[0][0] as Record<string, unknown>;

    expect(result).toEqual({ feedbackId: expect.stringMatching(/^FB-/), isFlagged: false });
    expect(savedDocument).toMatchObject({
      projectId: 'project-001',
      uploadedByOrganizationId: 'org-001',
      source: 'public',
      batchContentHash: expect.stringMatching(/^pub-/),
      beneficiaryNameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      submissionIpHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    const legacyConcatenatedHash = crypto
      .createHash('sha256')
      .update('203.0.113.10test-salt')
      .digest('hex');
    expect(savedDocument.submissionIpHash).not.toBe(legacyConcatenatedHash);
    expect(savedDocument).not.toHaveProperty('anonymousName');
    expect(savedDocument).toHaveProperty('submittedAt', expect.any(Date));
    expect(mockInvalidateStats).toHaveBeenCalledWith('project-001');
  });

  it('ghi FEEDBACK_FLAGGED khi public feedback bị gắn cờ', async () => {
    mockComputeRiskScore.mockReturnValue(8);
    mockShouldFlagFeedback.mockReturnValue(true);

    const result = await submitSingleFeedback(createPayload(), '203.0.113.10');

    expect(result.isFlagged).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'FEEDBACK_FLAGGED',
      projectId: 'project-001',
      organizationId: 'org-001',
      payload: expect.objectContaining({ riskScore: 8, source: 'public' })
    }));
  });

  it('accepts only ACTIVE, COMPLETED and CLOSED projects', async () => {
    for (const status of ['ACTIVE', 'COMPLETED', 'CLOSED']) {
      mockFindFeedbackProjectByProjectId.mockResolvedValueOnce({ ...project, status });
      await expect(submitSingleFeedback(createPayload({ submissionTicket: `ticket-${status}` }), '203.0.113.10')).resolves.toBeDefined();
    }

    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'REJECTED']) {
      mockFindFeedbackProjectByProjectId.mockResolvedValue({ ...project, status });
      await expect(submitSingleFeedback(createPayload({ submissionTicket: `ticket-${status}` }), '203.0.113.10'))
        .rejects.toMatchObject({
          errorCode: 'PROJECT_NOT_ACCEPTING_FEEDBACK',
          statusCode: 409
        });
    }
  });

  it('rejects duplicate long content and keeps the ticket consumed', async () => {
    mockClaimOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(submitSingleFeedback(createPayload(), '203.0.113.10')).rejects.toMatchObject({
      errorCode: 'DUPLICATE_SUBMISSION',
      statusCode: 429
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReleaseSubmissionSlot).not.toHaveBeenCalled();
  });

  it('rejects replay of the exact ticket before writing a second document', async () => {
    const claimedKeys = new Set<string>();
    mockVerifyTicket.mockImplementation((ticket: string) => ({
      projectId: 'project-001',
      issuedAt: Date.now(),
      nonce: ticket
    }));
    mockClaimOnce.mockImplementation(async (key: string) => {
      if (claimedKeys.has(key)) return false;
      claimedKeys.add(key);
      return true;
    });

    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'replay-ticket', comment: 'Ngắn' }), '203.0.113.10'))
      .resolves.toBeDefined();
    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'replay-ticket', comment: 'Khác nội dung' }), '203.0.113.10'))
      .rejects.toMatchObject({ errorCode: 'TICKET_ALREADY_USED' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('allows equivalent long content again after the 90-second duplicate window', async () => {
    vi.useFakeTimers();
    const claimedSlots = new Map<string, number>();
    mockVerifyTicket.mockImplementation((ticket: string) => ({
      projectId: 'project-001',
      issuedAt: Date.now(),
      nonce: ticket
    }));
    mockClaimOnce.mockImplementation(async (key: string, ttlSeconds: number) => {
      const currentTime = Date.now();
      const expiresAt = claimedSlots.get(key);
      if (expiresAt && expiresAt > currentTime) return false;
      claimedSlots.set(key, currentTime + ttlSeconds * 1000);
      return true;
    });

    const comment = '  Nội dung   cần chuẩn hóa cho duplicate test  ';
    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'window-1', comment }), '203.0.113.10'))
      .resolves.toBeDefined();
    await expect(submitSingleFeedback(createPayload({
      submissionTicket: 'window-2',
      comment: comment.toLocaleLowerCase('vi-VN').replace(/\s+/gu, ' ')
    }), '203.0.113.11')).rejects.toMatchObject({ errorCode: 'DUPLICATE_SUBMISSION' });

    vi.advanceTimersByTime(90_001);

    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'window-3', comment }), '203.0.113.11'))
      .resolves.toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not consume daily quota when the ticket is invalid', async () => {
    mockVerifyTicket.mockImplementationOnce(() => {
      throw new Error('invalid ticket');
    });

    await expect(submitSingleFeedback(createPayload(), '203.0.113.10')).rejects.toThrow('invalid ticket');
    expect(mockCountAgainstLimit).not.toHaveBeenCalled();
  });

  it('rejects when the distributed daily quota is exhausted', async () => {
    mockCountAgainstLimit.mockResolvedValueOnce(false);

    await expect(submitSingleFeedback(createPayload(), '203.0.113.10')).rejects.toMatchObject({
      errorCode: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not claim content slot for a short comment', async () => {
    await submitSingleFeedback(createPayload({ comment: 'Cảm ơn' }), '203.0.113.10');

    expect(mockClaimOnce).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('does not use the escaped formula prefix when checking the 20-character boundary', async () => {
    await submitSingleFeedback(createPayload({ comment: '=123456789012345678' }), '203.0.113.10');

    expect(mockClaimOnce).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('stores raw formula-like content and creates distinct anonymous hashes', async () => {
    await submitSingleFeedback(createPayload({ anonymousName: undefined, comment: '=SUM(A1:A2)' }), '203.0.113.10');
    await submitSingleFeedback(createPayload({ anonymousName: undefined, submissionTicket: 'ticket-2', comment: '=SUM(A1:A2)' }), '203.0.113.11');

    const firstDocument = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const secondDocument = mockCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(firstDocument.comment).toBe('=SUM(A1:A2)');
    expect(secondDocument.comment).toBe('=SUM(A1:A2)');
    expect(firstDocument.beneficiaryNameHash).not.toBe(secondDocument.beneficiaryNameHash);
  });

  it('allows identical short comments from different IPs without hitting the batch unique index', async () => {
    await submitSingleFeedback(createPayload({ comment: 'Cảm ơn', submissionTicket: 'short-1' }), '203.0.113.10');
    await submitSingleFeedback(createPayload({ comment: 'Cảm ơn', submissionTicket: 'short-2' }), '203.0.113.11');

    const firstDocument = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const secondDocument = mockCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(firstDocument.batchContentHash).not.toBe(secondDocument.batchContentHash);
  });

  it('allows many different contents from the same IP', async () => {
    for (let index = 0; index < 40; index += 1) {
      await expect(submitSingleFeedback(createPayload({
        comment: `Nội dung riêng biệt cho người dùng số ${index} trong buổi họp cộng đồng.`,
        submissionTicket: `ticket-${index}`
      }), '203.0.113.10')).resolves.toBeDefined();
    }

    expect(mockCreate).toHaveBeenCalledTimes(40);
  });

  it('releases claimed slots when Mongo insert fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(submitSingleFeedback(createPayload(), '203.0.113.10')).rejects.toThrow('database unavailable');
    expect(mockReleaseSubmissionSlot).toHaveBeenCalledTimes(2);
  });

  it('can retry successfully after a transient Mongo failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce({});

    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'retry-1' }), '203.0.113.10'))
      .rejects.toThrow('database unavailable');
    await expect(submitSingleFeedback(createPayload({ submissionTicket: 'retry-2' }), '203.0.113.10'))
      .resolves.toBeDefined();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockReleaseSubmissionSlot).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ACTIVE', true],
    ['COMPLETED', true],
    ['CLOSED', true],
    ['DRAFT', false],
    ['PENDING_APPROVAL', false],
    ['REJECTED', false]
  ] as const)('returns the correct form context for project status %s', async (status, isAcceptingFeedback) => {
    mockFindFeedbackProjectByProjectId.mockResolvedValue({ ...project, status });

    const result = await getPublicFeedbackFormContext('project-001');

    expect(result).toMatchObject({
      projectId: 'project-001',
      projectName: 'Dự án hỗ trợ',
      isAcceptingFeedback
    });
    if (isAcceptingFeedback) {
      expect(result.submissionTicket).toBe('ticket');
    } else {
      expect(result).not.toHaveProperty('submissionTicket');
    }
  });

  it('returns PROJECT_NOT_FOUND for a missing project context', async () => {
    mockFindFeedbackProjectByProjectId.mockResolvedValueOnce(undefined);

    await expect(getPublicFeedbackFormContext('missing-project')).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'PROJECT_NOT_FOUND'
    });
  });
});
