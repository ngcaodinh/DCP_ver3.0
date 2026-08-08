import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ManualReviewQueueRecord } from '../../models/manualReviewQueueModel';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => loggerMocks
}));

vi.mock('../../models/authModel', () => ({
  findUserById: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn()
}));

const socketEmitMock = vi.fn();
const socketToMock = vi.fn(() => ({ emit: socketEmitMock }));

vi.mock('../../config/socketServer', () => ({
  getSocketServer: vi.fn(() => ({ to: socketToMock }))
}));

vi.mock('../../services/manualReviewService', () => ({
  claimManualReviewEscalationCandidates: vi.fn(),
  markManualReviewEscalationNotified: vi.fn(),
  reconcileMissingManualReviewQueues: vi.fn(),
  releaseManualReviewEscalation: vi.fn()
}));

import * as authModel from '../../models/authModel';
import * as notificationService from '../../services/notificationService';
import * as manualReviewService from '../../services/manualReviewService';
import { runManualReviewEscalationOnce } from '../../workers/manualReviewEscalationWorker';

/** Tạo queue escalation candidate với SLA đã được snapshot trên queue item. */
function makeQueue(overrides: Partial<ManualReviewQueueRecord> = {}): ManualReviewQueueRecord {
  const now = new Date('2026-08-01T00:00:00.000Z');
  return {
    queueId: 'MRQ-001',
    disbursementRequestId: 'DS-001',
    payosTransferId: 'payos-001',
    projectId: 'project-001',
    organizationId: 'org-001',
    reason: 'PayOS failed',
    retryCount: 3,
    reviewCycle: 1,
    assignedAdminId: 'admin-001',
    assignmentMethod: 'LEAST_LOADED',
    status: 'PENDING',
    assignedAt: now,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionReason: null,
    slaDeadline: new Date('2026-07-31T00:00:00.000Z'),
    escalatedAt: now,
    actionLockId: null,
    actionLockExpiresAt: null,
    retentionExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('manualReviewEscalationWorker', () => {
  const originalSuperAdminUserId = process.env.SUPER_ADMIN_USER_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    process.env.SUPER_ADMIN_USER_ID = 'super-admin-001';
    vi.mocked(manualReviewService.reconcileMissingManualReviewQueues).mockResolvedValue({
      scanned: 0,
      opened: 0,
      skipped: 0,
      failed: 0,
      hasMore: false
    });
    vi.mocked(authModel.findUserById).mockResolvedValue({
      id: 'super-admin-001',
      role: 'admin',
      accountStatus: 'ACTIVE'
    } as never);
    vi.mocked(manualReviewService.claimManualReviewEscalationCandidates).mockResolvedValue([]);
    vi.mocked(manualReviewService.markManualReviewEscalationNotified).mockResolvedValue(null);
    vi.mocked(notificationService.createUserNotification).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.SUPER_ADMIN_USER_ID = originalSuperAdminUserId;
  });

  it('runs bounded reconciliation before evaluating SLA candidates', async () => {
    await runManualReviewEscalationOnce();

    expect(manualReviewService.reconcileMissingManualReviewQueues).toHaveBeenCalledWith({
      pageSize: 100,
      maxItems: 500
    });
    expect(manualReviewService.claimManualReviewEscalationCandidates).toHaveBeenCalledWith(
      new Date('2026-08-01T00:00:00.000Z'),
      100
    );
  });

  it('does not claim candidates when super admin config is missing', async () => {
    delete process.env.SUPER_ADMIN_USER_ID;

    await runManualReviewEscalationOnce();

    expect(loggerMocks.error).toHaveBeenCalledWith('Thiếu SUPER_ADMIN_USER_ID cho manual review escalation.');
    expect(manualReviewService.claimManualReviewEscalationCandidates).not.toHaveBeenCalled();
    expect(notificationService.createUserNotification).not.toHaveBeenCalled();
  });

  it('does not notify when configured super admin is not an active admin', async () => {
    vi.mocked(authModel.findUserById).mockResolvedValue({
      id: 'super-admin-001',
      role: 'organization',
      accountStatus: 'ACTIVE'
    } as never);

    await runManualReviewEscalationOnce();

    expect(manualReviewService.claimManualReviewEscalationCandidates).not.toHaveBeenCalled();
    expect(notificationService.createUserNotification).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      'SUPER_ADMIN_USER_ID không trỏ tới admin ACTIVE hợp lệ.',
      { superAdminConfigured: true }
    );
  });

  it('sends one escalation notification and socket event for claimed candidate', async () => {
    vi.mocked(manualReviewService.claimManualReviewEscalationCandidates).mockResolvedValue([
      makeQueue()
    ]);
    vi.mocked(manualReviewService.markManualReviewEscalationNotified).mockResolvedValue(makeQueue());

    await runManualReviewEscalationOnce();

    expect(notificationService.createUserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'super-admin-001',
        notificationType: 'MANUAL_REVIEW_ESCALATION',
        deduplicationKey: 'MANUAL_REVIEW_ESCALATION:MRQ-001',
        priority: 'CRITICAL',
        metadata: expect.objectContaining({
          requestId: 'DS-001',
          queueId: 'MRQ-001',
          hoursOverdue: 24
        })
      })
    );
    expect(socketToMock).toHaveBeenCalledWith('admin');
    expect(socketEmitMock).toHaveBeenCalledWith(
      'transfer:escalation-alert',
      expect.objectContaining({
        requestId: 'DS-001',
        queueId: 'MRQ-001',
        hoursOverdue: 24
      })
    );
    expect(manualReviewService.markManualReviewEscalationNotified).toHaveBeenCalledWith(
      'MRQ-001',
      new Date('2026-08-01T00:00:00.000Z')
    );
  });

  it('does not mark escalation when notification creation fails', async () => {
    vi.mocked(manualReviewService.claimManualReviewEscalationCandidates).mockResolvedValue([
      makeQueue()
    ]);
    vi.mocked(notificationService.createUserNotification).mockRejectedValue(new Error('notify unavailable'));

    await runManualReviewEscalationOnce();

    expect(manualReviewService.markManualReviewEscalationNotified).not.toHaveBeenCalled();
    expect(socketEmitMock).not.toHaveBeenCalled();
  });
});
