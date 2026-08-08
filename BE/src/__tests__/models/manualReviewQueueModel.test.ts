import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  acquireManualReviewActionLease,
  ManualReviewQueueMongoModel,
  resolveManualReviewQueue,
  upsertManualReviewQueue
} from '../../models/manualReviewQueueModel';

type QueueIndexEntry = [
  Record<string, 1 | -1>,
  {
    unique?: boolean;
    expireAfterSeconds?: number;
  }
];

/** Tạo query chain tối thiểu cho các helper model dùng findOneAndUpdate(). */
function createLeanExecChain<T>(value: T) {
  return {
    lean: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(value)
    })
  };
}

describe('manualReviewQueueModel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defines durable queue indexes and TTL only on retentionExpiresAt', () => {
    const indexes = ManualReviewQueueMongoModel.schema.indexes() as QueueIndexEntry[];
    const hasUniqueCycleIndex = indexes.some(([fields, options]) => (
      fields.disbursementRequestId === 1
      && fields.reviewCycle === 1
      && options?.unique === true
    ));
    const hasWorkloadIndex = indexes.some(([fields]) => (
      fields.assignedAdminId === 1
      && fields.status === 1
      && fields.createdAt === 1
    ));
    const hasSlaIndex = indexes.some(([fields]) => fields.status === 1 && fields.slaDeadline === 1);
    const hasRetentionTtl = indexes.some(([fields, options]) => (
      fields.retentionExpiresAt === 1
      && options?.expireAfterSeconds === 0
    ));

    expect(hasUniqueCycleIndex).toBe(true);
    expect(hasWorkloadIndex).toBe(true);
    expect(hasSlaIndex).toBe(true);
    expect(hasRetentionTtl).toBe(true);
    expect(ManualReviewQueueMongoModel.schema.path('bankAccountNumber')).toBeUndefined();
    expect(ManualReviewQueueMongoModel.schema.path('accountHolderName')).toBeUndefined();
  });

  it('creates pending queue by requestId and reviewCycle without storing bank PII', async () => {
    const queue = { queueId: 'MRQ-001', disbursementRequestId: 'DS-001', reviewCycle: 1 };
    vi.spyOn(ManualReviewQueueMongoModel, 'findOne')
      .mockReturnValue(createLeanExecChain(null) as never);
    const createSpy = vi
      .spyOn(ManualReviewQueueMongoModel, 'create')
      .mockResolvedValue({ toObject: () => queue } as never);

    const result = await upsertManualReviewQueue({
      disbursementRequestId: 'DS-001',
      payosTransferId: 'payos-001',
      projectId: 'project-001',
      organizationId: 'org-001',
      reason: 'PayOS failed',
      retryCount: 3,
      reviewCycle: 1,
      assignedAdminId: 'admin-001',
      assignmentMethod: 'LEAST_LOADED',
      assignedAt: new Date('2026-08-01T00:00:00.000Z'),
      slaDeadline: new Date('2026-08-04T00:00:00.000Z')
    });

    expect(result).toEqual({ queue, created: true });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      disbursementRequestId: 'DS-001',
      reviewCycle: 1,
      projectId: 'project-001',
      organizationId: 'org-001',
      reason: 'PayOS failed',
      retryCount: 3,
      assignedAdminId: 'admin-001',
      slaDeadline: new Date('2026-08-04T00:00:00.000Z'),
      escalatedAt: null,
      actionLockId: null,
      actionLockExpiresAt: null
    }));
    expect(JSON.stringify(createSpy.mock.calls[0]?.[0] ?? {})).not.toContain('bankAccountNumber');
    expect(JSON.stringify(createSpy.mock.calls[0]?.[0] ?? {})).not.toContain('accountHolderName');
  });

  it('replays pending queue without resetting assignment, SLA, escalation, or action lease', async () => {
    const existingQueue = {
      queueId: 'MRQ-001',
      disbursementRequestId: 'DS-001',
      reviewCycle: 1,
      status: 'PENDING',
      actionLockId: 'lock-001',
      escalatedAt: new Date('2026-08-02T00:00:00.000Z')
    };
    const updatedQueue = { ...existingQueue, reason: 'PayOS failed replay', retryCount: 4 };
    vi.spyOn(ManualReviewQueueMongoModel, 'findOne')
      .mockReturnValue(createLeanExecChain(existingQueue) as never);
    const findOneAndUpdateSpy = vi
      .spyOn(ManualReviewQueueMongoModel, 'findOneAndUpdate')
      .mockReturnValue(createLeanExecChain(updatedQueue) as never);

    const result = await upsertManualReviewQueue({
      disbursementRequestId: 'DS-001',
      payosTransferId: 'payos-001',
      projectId: 'project-001',
      organizationId: 'org-001',
      reason: 'PayOS failed replay',
      retryCount: 4,
      reviewCycle: 1,
      assignedAdminId: 'admin-002',
      assignmentMethod: 'LEAST_LOADED',
      assignedAt: new Date('2026-08-01T00:00:00.000Z'),
      slaDeadline: new Date('2026-08-04T00:00:00.000Z')
    });

    const update = findOneAndUpdateSpy.mock.calls[0]?.[1];
    expect(result).toEqual({ queue: updatedQueue, created: false });
    expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
      { disbursementRequestId: 'DS-001', reviewCycle: 1, status: 'PENDING' },
      expect.objectContaining({
        $set: expect.objectContaining({
          payosTransferId: 'payos-001',
          reason: 'PayOS failed replay',
          retryCount: 4
        })
      }),
      { returnDocument: 'after' }
    );
    expect(update).not.toEqual(expect.objectContaining({
      $set: expect.objectContaining({
        assignedAdminId: 'admin-001',
        slaDeadline: new Date('2026-08-04T00:00:00.000Z'),
        escalatedAt: null,
        actionLockId: null,
        actionLockExpiresAt: null
      })
    }));
    expect(JSON.stringify((update as { $set?: Record<string, unknown> }).$set ?? {})).not.toContain('actionLockId');
    expect(JSON.stringify((update as { $set?: Record<string, unknown> }).$set ?? {})).not.toContain('assignedAdminId');
    expect(JSON.stringify((update as { $set?: Record<string, unknown> }).$set ?? {})).not.toContain('slaDeadline');
    expect(JSON.stringify((update as { $set?: Record<string, unknown> }).$set ?? {})).not.toContain('escalatedAt');
    expect(JSON.stringify(update ?? {})).not.toContain('bankAccountNumber');
    expect(JSON.stringify(update ?? {})).not.toContain('accountHolderName');
  });

  it('does not reopen a resolved queue item from the same review cycle', async () => {
    const resolvedQueue = { queueId: 'MRQ-001', disbursementRequestId: 'DS-001', reviewCycle: 1, status: 'REJECTED' };
    vi.spyOn(ManualReviewQueueMongoModel, 'findOne')
      .mockReturnValue(createLeanExecChain(resolvedQueue) as never);
    const findOneAndUpdateSpy = vi
      .spyOn(ManualReviewQueueMongoModel, 'findOneAndUpdate')
      .mockReturnValue(createLeanExecChain({}) as never);

    const result = await upsertManualReviewQueue({
      disbursementRequestId: 'DS-001',
      payosTransferId: 'payos-001',
      projectId: 'project-001',
      organizationId: 'org-001',
      reason: 'PayOS failed',
      retryCount: 3,
      reviewCycle: 1,
      assignedAdminId: 'admin-001',
      assignmentMethod: 'LEAST_LOADED',
      assignedAt: new Date('2026-08-01T00:00:00.000Z'),
      slaDeadline: new Date('2026-08-04T00:00:00.000Z')
    });

    expect(result).toEqual({ queue: resolvedQueue, created: false });
    expect(findOneAndUpdateSpy).not.toHaveBeenCalled();
  });

  it('acquires action lease only for pending unlocked or expired items', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const leaseExpiresAt = new Date('2026-08-01T00:05:00.000Z');
    const queryChain = createLeanExecChain({ queueId: 'MRQ-001' });
    const findOneAndUpdateSpy = vi
      .spyOn(ManualReviewQueueMongoModel, 'findOneAndUpdate')
      .mockReturnValue(queryChain as never);

    await acquireManualReviewActionLease({
      disbursementRequestId: 'DS-001',
      lockId: 'lock-001',
      now,
      leaseExpiresAt
    });

    expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        disbursementRequestId: 'DS-001',
        status: 'PENDING',
        $or: [
          { actionLockId: null },
          { actionLockExpiresAt: null },
          { actionLockExpiresAt: { $lte: now } }
        ]
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ actionLockId: 'lock-001', actionLockExpiresAt: leaseExpiresAt })
      }),
      { returnDocument: 'after' }
    );
  });

  it('resolves queue once and sets five-year retention after completion', async () => {
    const resolvedAt = new Date('2026-08-01T00:00:00.000Z');
    const queryChain = createLeanExecChain({ queueId: 'MRQ-001', status: 'REJECTED' });
    const findOneAndUpdateSpy = vi
      .spyOn(ManualReviewQueueMongoModel, 'findOneAndUpdate')
      .mockReturnValue(queryChain as never);

    await resolveManualReviewQueue({
      queueId: 'MRQ-001',
      lockId: 'lock-001',
      status: 'REJECTED',
      adminUserId: 'admin-001',
      reason: 'Invalid documents',
      resolvedAt
    });

    const update = findOneAndUpdateSpy.mock.calls[0]?.[1] as {
      $set: { retentionExpiresAt: Date; actionLockId: null };
    };
    expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
      { queueId: 'MRQ-001', actionLockId: 'lock-001', status: 'PENDING' },
      expect.anything(),
      { returnDocument: 'after' }
    );
    expect(update.$set.retentionExpiresAt).toEqual(new Date('2031-08-01T00:00:00.000Z'));
    expect(update.$set.actionLockId).toBeNull();
  });
});
