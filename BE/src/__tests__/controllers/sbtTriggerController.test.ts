import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

const verifyOracleTriggerRequestMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock('../../services/sbt-trigger.service', () => ({
  triggerSbtMintFromOracle: vi.fn(),
  isTransactionStuck: vi.fn(),
  verifyOracleTriggerRequest: verifyOracleTriggerRequestMock
}));
vi.mock('../../utils/apiResponse', () => ({
  sendSuccessResponse: vi.fn(),
  sendErrorResponse: vi.fn()
}));

import { handleSbtTrigger } from '../../controllers/sbtTriggerController';
import {
  triggerSbtMintFromOracle,
  isTransactionStuck
} from '../../services/sbt-trigger.service';
import { sendSuccessResponse, sendErrorResponse } from '../../utils/apiResponse';

function buildMockRequest(body: Record<string, unknown> = {}): AuthenticatedRequest {
  const headers: Record<string, string> = {
    'x-oracle-signature': 'a'.repeat(64),
    'x-oracle-timestamp': '1700000000',
    'x-oracle-nonce': 'nonce-1234567890'
  };
  return {
    body,
    authenticatedUser: { userId: 'oracle-1', role: 'oracle' },
    params: {},
    query: {},
    get: vi.fn((name: string) => headers[name.toLowerCase()])
  } as unknown as AuthenticatedRequest;
}

function buildMockResponse(): Response {
  return {} as Response;
}

function buildMockResult(overrides: Record<string, unknown> = {}) {
  return {
    record: {
      sbtId: 'SBT-001',
      mintRequestId: 'SBT-MINT-001',
      verificationId: 'ver-123',
      projectId: 'project-1',
      status: 'PENDING',
      transactionHash: null,
      submittedAt: null,
      ...overrides
    },
    jobId: 'job-123',
    enqueued: true,
    duplicate: false
  };
}

describe('sbtTriggerController - handleSbtTrigger', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    verifyOracleTriggerRequestMock.mockResolvedValue(undefined);
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockReset();
    (isTransactionStuck as ReturnType<typeof vi.fn>).mockReset();
  });

  it('validates headers and forwards only verificationId', async () => {
    const req = buildMockRequest({ verificationId: 'ver-123', projectId: 'forged-project' });
    const res = buildMockResponse();
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockResult());

    await handleSbtTrigger(req, res);

    expect(verifyOracleTriggerRequestMock).toHaveBeenCalledWith(
      'ver-123',
      expect.objectContaining({ signature: 'a'.repeat(64), nonce: 'nonce-1234567890' })
    );
    expect(triggerSbtMintFromOracle).toHaveBeenCalledWith({ verificationId: 'ver-123' });
    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 201, expect.any(String), expect.objectContaining({ enqueued: true }));
  });

  it('rejects invalid body before HMAC/service', async () => {
    const res = buildMockResponse();
    await handleSbtTrigger(buildMockRequest({ projectId: 'missing-verification' }), res);

    expect(sendErrorResponse).toHaveBeenCalledWith(
      res,
      400,
      'Validation failed.',
      'VALIDATION_ERROR',
      expect.arrayContaining([expect.objectContaining({ field: 'verificationId' })])
    );
    expect(verifyOracleTriggerRequestMock).not.toHaveBeenCalled();
    expect(triggerSbtMintFromOracle).not.toHaveBeenCalled();
  });

  it('maps HMAC rejection to its application status', async () => {
    verifyOracleTriggerRequestMock.mockRejectedValue({
      message: 'signature invalid',
      statusCode: 401,
      code: 'ORACLE_SIGNATURE_INVALID'
    });

    await handleSbtTrigger(buildMockRequest({ verificationId: 'ver-123' }), buildMockResponse());

    expect(sendErrorResponse).toHaveBeenCalledWith(
      expect.anything(),
      401,
      'signature invalid',
      'ORACLE_SIGNATURE_INVALID'
    );
    expect(triggerSbtMintFromOracle).not.toHaveBeenCalled();
  });

  it('returns 200 for duplicate and suppresses stale stuck warning', async () => {
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...buildMockResult({ status: 'SUBMITTED', submittedAt: new Date('2025-01-01T00:00:00Z') }),
      duplicate: true,
      enqueued: false,
      jobId: undefined
    });
    (isTransactionStuck as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = buildMockResponse();

    await handleSbtTrigger(buildMockRequest({ verificationId: 'ver-123' }), res);

    expect(sendSuccessResponse).toHaveBeenCalledWith(res, 200, expect.any(String), expect.objectContaining({
      duplicate: true,
      warning: undefined
    }));
  });

  it('returns 500 for unexpected service failure', async () => {
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('database down'));

    await handleSbtTrigger(buildMockRequest({ verificationId: 'ver-123' }), buildMockResponse());

    expect(sendErrorResponse).toHaveBeenCalledWith(
      expect.anything(),
      500,
      'Lỗi server khi trigger SBT mint.',
      'INTERNAL_ERROR'
    );
  });
});
