import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  mark: vi.fn(),
  release: vi.fn(),
  disbursement: vi.fn(),
  sbt: vi.fn(),
  removePending: vi.fn(),
  audit: vi.fn()
}));

vi.mock('../../models/adminActionOutboxModel', () => ({
  claimAdminActionOutbox: mocks.claim,
  markAdminActionOutboxDispatched: mocks.mark,
  releaseAdminActionOutbox: mocks.release
}));
vi.mock('../../queues/disbursementTransferQueue', () => ({
  enqueueDisbursementTransfer: mocks.disbursement,
  getDisbursementTransferJobId: vi.fn(() => 'fallback-job-id'),
  removePendingJobsByRequestId: mocks.removePending
}));
vi.mock('../../queues/sbtMintQueue', () => ({ enqueueSbtMint: mocks.sbt }));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.audit }));

import { runAdminActionOutboxOnce } from '../../workers/adminActionOutboxWorker';

describe('adminActionOutboxWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(null);
    mocks.mark.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined);
    mocks.removePending.mockResolvedValue(0);
    mocks.audit.mockResolvedValue({});
  });

  it('dispatches manual approve after commit and marks event dispatched', async () => {
    mocks.claim
      .mockResolvedValueOnce({
        eventId: 'event-1',
        eventType: 'MANUAL_APPROVE_TRANSFER',
        payload: { requestId: 'request-1', idempotencyKey: 'key-1' },
        attempts: 1
      })
      .mockResolvedValueOnce(null);
    mocks.disbursement.mockResolvedValue({ enqueued: true, jobId: 'job-1' });

    await expect(runAdminActionOutboxOnce()).resolves.toBe(1);
    expect(mocks.disbursement).toHaveBeenCalledWith('request-1', 1, 'key-1');
    expect(mocks.removePending).toHaveBeenCalledWith('request-1', 'job-1');
    expect(mocks.mark).toHaveBeenCalledWith('event-1', expect.any(Date));
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('releases event for retry when queue dispatch fails', async () => {
    mocks.claim
      .mockResolvedValueOnce({
        eventId: 'event-2',
        eventType: 'SBT_MINT_RERUN',
        payload: { mintRequestId: 'mint-1', sbtId: 'sbt-1', attemptNumber: 1 },
        attempts: 2
      })
      .mockResolvedValueOnce(null);
    mocks.sbt.mockResolvedValue({ enqueued: false, jobId: undefined });

    await expect(runAdminActionOutboxOnce()).resolves.toBe(0);
    expect(mocks.release).toHaveBeenCalledWith('event-2', expect.any(Date));
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('retries a failed SBT dispatch and records ENQUEUED only after queue success', async () => {
    mocks.claim
      .mockResolvedValueOnce({
        eventId: 'event-3',
        eventType: 'SBT_MINT_RERUN',
        payload: {
          mintRequestId: 'mint-1',
          sbtId: 'sbt-1',
          attemptNumber: 1,
          adminId: 'admin-1',
          adminRole: 'admin',
          previousStatus: 'DLQ',
          previousAttemptNumber: 6,
          reRunCount: 1,
          requestContext: { ipAddress: '10.0.0.1', userAgent: 'test-agent' }
        },
        attempts: 2
      })
      .mockResolvedValueOnce(null);
    mocks.sbt.mockResolvedValue({ enqueued: true, jobId: 'mint-1-attempt1' });

    await expect(runAdminActionOutboxOnce()).resolves.toBe(1);
    expect(mocks.mark).toHaveBeenCalledWith('event-3', expect.any(Date));
    const { recordAdminAuditLog } = await import('../../services/audit-log.service');
    expect(recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'event-3:enqueued',
      actionType: 'SBT_MINT_RERUN_ENQUEUED',
      context: expect.objectContaining({ dispatchAttempt: 2, jobId: 'mint-1-attempt1' })
    }));
  });

  it('retries audit after queue acceptance without creating a second logical job', async () => {
    const event = {
      eventId: 'event-4',
      eventType: 'SBT_MINT_RERUN',
      payload: {
        mintRequestId: 'mint-1',
        sbtId: 'sbt-1',
        attemptNumber: 1,
        adminId: 'admin-1',
        adminRole: 'admin',
        previousStatus: 'DLQ',
        previousAttemptNumber: 6,
        reRunCount: 1
      },
      attempts: 1
    };
    mocks.claim
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({ ...event, attempts: 2 })
      .mockResolvedValueOnce(null);
    mocks.sbt.mockResolvedValue({ enqueued: true, jobId: 'mint-1-attempt1' });
    mocks.audit.mockRejectedValueOnce(new Error('audit transaction unavailable'));

    await expect(runAdminActionOutboxOnce()).resolves.toBe(1);
    expect(mocks.sbt).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledWith('event-4', expect.any(Date));
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.mark).toHaveBeenCalledTimes(2);
  });
});
