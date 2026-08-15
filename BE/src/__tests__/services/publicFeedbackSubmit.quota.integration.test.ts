import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicFeedbackSubmitPayload } from '../../validators/publicFeedbackSubmitValidator';

const { mockFindFeedbackProjectByProjectId, mockCreate, mockVerifySubmissionTicket } = vi.hoisted(() => ({
  mockFindFeedbackProjectByProjectId: vi.fn(),
  mockCreate: vi.fn(),
  mockVerifySubmissionTicket: vi.fn<(ticket: string) => { projectId: string; issuedAt: number; nonce: string }>()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../models/projectModel', () => ({
  findFeedbackProjectByProjectId: mockFindFeedbackProjectByProjectId
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: { create: mockCreate }
}));

vi.mock('../../utils/feedbackSubmissionTicket', () => ({
  TICKET_TTL_SECONDS: 1800,
  issueSubmissionTicket: vi.fn(),
  verifySubmissionTicket: mockVerifySubmissionTicket
}));

vi.mock('../../services/publicFeedback.service', () => ({
  invalidatePublicFeedbackStatsCache: vi.fn()
}));

import { submitSingleFeedback } from '../../services/publicFeedbackSubmit.service';
import {
  __resetSubmissionThrottleState,
  countAgainstLimit,
  MAX_FALLBACK_ENTRIES
} from '../../utils/submissionThrottle';

const project = {
  projectId: 'project-001',
  organizationId: 'org-001',
  name: 'Dự án hỗ trợ',
  status: 'ACTIVE'
} as const;

/** Tạo payload ngắn để kiểm tra quota mà không kích hoạt content duplicate window. */
function createPayload(index: number): PublicFeedbackSubmitPayload {
  return {
    projectId: project.projectId,
    rating: 5,
    comment: 'Cảm ơn',
    submissionTicket: `quota-ticket-${index}`
  };
}

describe('public feedback quota integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSubmissionThrottleState();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FEEDBACK_IP_HASH_SALT', 'quota-test-salt');
    mockFindFeedbackProjectByProjectId.mockResolvedValue(project);
    mockCreate.mockResolvedValue({});
    mockVerifySubmissionTicket.mockImplementation((ticket: string) => ({
      projectId: project.projectId,
      issuedAt: Date.now(),
      nonce: ticket
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('accepts 500 submissions per day and rejects the 501st', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-14T00:00:00.000Z') });

    for (let index = 0; index < 500; index += 1) {
      await expect(submitSingleFeedback(createPayload(index), '203.0.113.10')).resolves.toBeDefined();
    }

    await expect(submitSingleFeedback(createPayload(500), '203.0.113.10')).rejects.toMatchObject({
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED'
    });
    expect(mockCreate).toHaveBeenCalledTimes(500);
  });

  it('enforces ticket replay, normalized duplicate content, and the 90-second expiry with real fallback state', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-14T12:00:00.000Z') });
    const duplicateComment = '  Nội dung   cần chuẩn hóa trong buổi họp cộng đồng  ';

    await expect(submitSingleFeedback({
      ...createPayload(1),
      comment: 'Ngắn',
      submissionTicket: 'replay-ticket'
    }, '203.0.113.10')).resolves.toBeDefined();
    await expect(submitSingleFeedback({
      ...createPayload(2),
      comment: 'Nội dung khác',
      submissionTicket: 'replay-ticket'
    }, '203.0.113.10')).rejects.toMatchObject({ errorCode: 'TICKET_ALREADY_USED' });

    await expect(submitSingleFeedback({
      ...createPayload(3),
      comment: duplicateComment,
      submissionTicket: 'duplicate-ticket-1'
    }, '203.0.113.10')).resolves.toBeDefined();
    await expect(submitSingleFeedback({
      ...createPayload(4),
      comment: duplicateComment.toLocaleLowerCase('vi-VN').replace(/\s+/gu, ' '),
      submissionTicket: 'duplicate-ticket-2'
    }, '203.0.113.11')).rejects.toMatchObject({ errorCode: 'DUPLICATE_SUBMISSION' });

    vi.advanceTimersByTime(90_001);

    await expect(submitSingleFeedback({
      ...createPayload(5),
      comment: duplicateComment,
      submissionTicket: 'duplicate-ticket-3'
    }, '203.0.113.11')).resolves.toBeDefined();

    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('releases real fallback slots after a database failure so the same ticket can retry', async () => {
    mockCreate.mockRejectedValueOnce(new Error('database unavailable'));
    const payload = {
      ...createPayload(6),
      comment: '=SUM(A1:A2)',
      submissionTicket: 'retry-ticket'
    };

    await expect(submitSingleFeedback(payload, '203.0.113.10')).rejects.toThrow('database unavailable');
    await expect(submitSingleFeedback(payload, '203.0.113.10')).resolves.toBeDefined();

    const savedDocument = mockCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(savedDocument.comment).toBe('=SUM(A1:A2)');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('creates different internal hashes for two anonymous submissions without exposing them through public reads', async () => {
    await expect(submitSingleFeedback({
      ...createPayload(7),
      anonymousName: undefined,
      submissionTicket: 'anonymous-ticket-1'
    }, '203.0.113.10')).resolves.toBeDefined();
    await expect(submitSingleFeedback({
      ...createPayload(8),
      anonymousName: undefined,
      submissionTicket: 'anonymous-ticket-2'
    }, '203.0.113.11')).resolves.toBeDefined();

    const firstDocument = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const secondDocument = mockCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(firstDocument.beneficiaryNameHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondDocument.beneficiaryNameHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstDocument.beneficiaryNameHash).not.toBe(secondDocument.beneficiaryNameHash);
  });

  it('maps fallback store saturation to 429 instead of a ticket or duplicate error', async () => {
    for (let index = 0; index < MAX_FALLBACK_ENTRIES; index += 1) {
      await countAgainstLimit(`occupied-${index}`, 1, 86400);
    }

    await expect(submitSingleFeedback(createPayload(9), '203.0.113.10')).rejects.toMatchObject({
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED'
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
