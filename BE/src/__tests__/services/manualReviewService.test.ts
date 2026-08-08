import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DisbursementRecord } from '../../models/disbursementModel';
import type { ManualReviewQueueRecord } from '../../models/manualReviewQueueModel';

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const redisIncrMock = vi.fn();

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: vi.fn(),
  findDisbursementsByRequestIds: vi.fn(),
  findDisbursementsInManualReview: vi.fn(),
  updateDisbursementByRequestIdWithCondition: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  findUsersByRole: vi.fn(),
  findUsersByWalletAddressList: vi.fn()
}));

vi.mock('../../models/donationModel', () => ({
  findDonationsByProjectId: vi.fn()
}));

vi.mock('../../models/disbursementTransferModel', () => ({
  findTransferLogsByRequestId: vi.fn()
}));

vi.mock('../../models/adminAuditLogModel', () => ({
  createAdminAuditLog: vi.fn(),
  findAuditLogsByRequestId: vi.fn()
}));

vi.mock('../../models/manualReviewQueueModel', () => ({
  findLatestManualReviewQueueByRequestId: vi.fn(),
  findPendingManualReviewQueueByRequestId: vi.fn(),
  findPendingManualReviewQueuesByProject: vi.fn(),
  findPendingManualReviewQueuesPaginated: vi.fn(),
  findManualReviewEscalationCandidates: vi.fn(),
  claimManualReviewEscalationCandidates: vi.fn(),
  markManualReviewQueueEscalated: vi.fn(),
  releaseManualReviewEscalationClaim: vi.fn(),
  countPendingManualReviewByAdminIds: vi.fn(),
  acquireManualReviewActionLease: vi.fn(),
  releaseManualReviewActionLease: vi.fn(),
  resolveManualReviewQueue: vi.fn(),
  upsertManualReviewQueue: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn()
}));

vi.mock('../../queues/disbursementTransferQueue', () => ({
  enqueueDisbursementTransfer: vi.fn(),
  removePendingJobsByRequestId: vi.fn()
}));

const socketEmitMock = vi.fn();
const socketToMock = vi.fn(() => ({ emit: socketEmitMock }));

vi.mock('../../config/socketServer', () => ({
  getSocketServer: vi.fn(() => ({ to: socketToMock }))
}));

vi.mock('../../services/payosService', () => ({
  getPayosTransferStatusByReferenceId: vi.fn()
}));

import * as redisConfig from '../../config/redis';
import * as disbursementModel from '../../models/disbursementModel';
import * as authModel from '../../models/authModel';
import * as donationModel from '../../models/donationModel';
import * as auditLogModel from '../../models/adminAuditLogModel';
import * as queueModel from '../../models/manualReviewQueueModel';
import * as notificationService from '../../services/notificationService';
import * as transferQueue from '../../queues/disbursementTransferQueue';
import * as payosService from '../../services/payosService';
import {
  claimManualReviewEscalationCandidates,
  getManualReviewDetail,
  getPendingManualReview,
  manualApprove,
  manualReject,
  markManualReviewEscalationNotified,
  reconcileMissingManualReviewQueues,
  openManualReviewQueueForDisbursement
} from '../../services/manualReviewService';

function makeDisbursement(overrides: Partial<DisbursementRecord> = {}): DisbursementRecord {
  const now = new Date('2026-08-01T00:00:00.000Z');
  return {
    requestId: 'DS-001',
    onChainRequestId: 1,
    projectId: 'project-001',
    onChainProjectId: 1,
    organizationId: 'org-001',
    requestMode: 'NORMAL',
    emergencyReason: null,
    requiredApprovals: 2,
    raisedRatioBpsAtCreation: 5000,
    beneficiaryWalletAddress: '0x0000000000000000000000000000000000000000',
    beneficiaryBankAccount: {
      bankName: 'VCB',
      bankAccountNumber: '1234567890',
      accountHolderName: 'Nguyen Van A'
    },
    amount: 100000,
    usagePurpose: 'Test',
    evidenceCid: 'QmTest',
    status: 'APPROVED',
    approvals: [],
    rejection: null,
    timeoutDeadline: null,
    payosTransferId: 'payos-001',
    payosTransferStatus: 'MANUAL_REVIEW',
    payosTransferAttemptCount: 3,
    payosTransferLastError: 'PayOS failed',
    transferIdempotencyKey: 'disbursement-DS-001',
    transactionHash: null,
    finalizeTransactionHash: null,
    createdAt: now,
    updatedAt: now,
    expiredAt: null,
    completedAt: null,
    ...overrides
  };
}

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
    slaDeadline: new Date('2026-08-04T00:00:00.000Z'),
    escalatedAt: null,
    actionLockId: null,
    actionLockExpiresAt: null,
    retentionExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('manualReviewService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auditLogModel.createAdminAuditLog).mockReset();
    vi.mocked(redisConfig.getRedisClientIfReady).mockReturnValue(null);
    redisIncrMock.mockReset();
    vi.mocked(authModel.findUsersByRole).mockResolvedValue([
      { id: 'admin-001', role: 'admin', accountStatus: 'ACTIVE' } as never
    ]);
    vi.mocked(queueModel.findPendingManualReviewQueuesByProject).mockResolvedValue([]);
    vi.mocked(queueModel.countPendingManualReviewByAdminIds).mockResolvedValue(new Map([['admin-001', 0]]));
    vi.mocked(notificationService.createUserNotification).mockResolvedValue(null);
    vi.mocked(donationModel.findDonationsByProjectId).mockResolvedValue([]);
    vi.mocked(authModel.findUsersByWalletAddressList).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { requestMode: 'NORMAL' as const, slaHours: 72 },
    { requestMode: 'EMERGENCY' as const, slaHours: 24 }
  ])('snapshots $requestMode SLA at queue creation', async ({ requestMode, slaHours }) => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const queue = makeQueue({
      slaDeadline: new Date(now.getTime() + slaHours * 60 * 60 * 1000)
    });
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({ queue, created: true });

    await openManualReviewQueueForDisbursement({
      disbursement: makeDisbursement({ requestMode }),
      reason: 'PayOS failed',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(expect.objectContaining({
      slaDeadline: new Date(now.getTime() + slaHours * 60 * 60 * 1000)
    }));
  });

  it('opens a durable queue item and emits realtime only after upsert succeeds', async () => {
    const disbursement = makeDisbursement();
    const queue = makeQueue();
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({ queue, created: true });

    const result = await openManualReviewQueueForDisbursement({
      disbursement,
      reason: '  PayOS   failed  ',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(result).toEqual(queue);
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        disbursementRequestId: 'DS-001',
        reason: 'PayOS failed',
        reviewCycle: 1,
        assignedAdminId: 'admin-001',
        assignmentMethod: 'LEAST_LOADED'
      })
    );
    expect(socketToMock).toHaveBeenCalledWith('admin');
    expect(socketEmitMock).toHaveBeenCalledWith(
      'transfer:manual-review-required',
      expect.objectContaining({ requestId: 'DS-001', queueId: 'MRQ-001' })
    );
  });

  it('updates existing pending cycle without duplicate notification or realtime event', async () => {
    const disbursement = makeDisbursement();
    const queue = makeQueue();
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(queue);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({ queue, created: false });

    await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed replay',
      retryCount: 3,
      source: 'payos_webhook_failed'
    });

    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ reviewCycle: 1 })
    );
    expect(authModel.findUsersByRole).not.toHaveBeenCalled();
    expect(notificationService.createUserNotification).not.toHaveBeenCalled();
    expect(socketEmitMock).not.toHaveBeenCalled();
  });

  it('opens a new review cycle after the latest queue was resolved', async () => {
    const disbursement = makeDisbursement();
    const resolvedQueue = makeQueue({ status: 'REJECTED', reviewCycle: 1 });
    const nextQueue = makeQueue({ queueId: 'MRQ-002', reviewCycle: 2 });
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(resolvedQueue);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({ queue: nextQueue, created: true });

    const result = await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed again',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(result.reviewCycle).toBe(2);
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ reviewCycle: 2 })
    );
    expect(socketEmitMock).toHaveBeenCalledWith(
      'transfer:manual-review-required',
      expect.objectContaining({ queueId: 'MRQ-002' })
    );
  });

  it('retries with next cycle when pending queue resolves during upsert', async () => {
    const disbursement = makeDisbursement();
    const pendingQueue = makeQueue({ status: 'PENDING', reviewCycle: 1 });
    const resolvedQueue = makeQueue({ status: 'APPROVED', reviewCycle: 1 });
    const nextQueue = makeQueue({ queueId: 'MRQ-002', reviewCycle: 2 });
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId)
      .mockResolvedValueOnce(pendingQueue)
      .mockResolvedValueOnce(resolvedQueue);
    vi.mocked(queueModel.upsertManualReviewQueue)
      .mockResolvedValueOnce({ queue: resolvedQueue, created: false })
      .mockResolvedValueOnce({ queue: nextQueue, created: true });

    const result = await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed after race',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(result).toEqual(nextQueue);
    expect(queueModel.upsertManualReviewQueue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reviewCycle: 2 })
    );
    expect(socketEmitMock).toHaveBeenCalledWith(
      'transfer:manual-review-required',
      expect.objectContaining({ queueId: 'MRQ-002' })
    );
  });

  it('does not assign inactive admins even if repository mock returns them', async () => {
    const disbursement = makeDisbursement();
    vi.mocked(authModel.findUsersByRole).mockResolvedValue([
      { id: 'admin-inactive', role: 'admin', accountStatus: 'INACTIVE_PENDING_KYC' },
      { id: 'admin-active', role: 'admin', accountStatus: 'ACTIVE' }
    ] as never);
    vi.mocked(queueModel.countPendingManualReviewByAdminIds).mockResolvedValue(new Map([['admin-active', 0]]));
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({
      queue: makeQueue({ assignedAdminId: 'admin-active' }),
      created: true
    });

    await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(queueModel.countPendingManualReviewByAdminIds).toHaveBeenCalledWith(['admin-active']);
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAdminId: 'admin-active' })
    );
  });

  it('uses project affinity before round-robin or least-loaded fallback', async () => {
    const disbursement = makeDisbursement();
    vi.mocked(authModel.findUsersByRole).mockResolvedValue([
      { id: 'admin-001', role: 'admin', accountStatus: 'ACTIVE' },
      { id: 'admin-002', role: 'admin', accountStatus: 'ACTIVE' }
    ] as never);
    vi.mocked(queueModel.findPendingManualReviewQueuesByProject).mockResolvedValue([
      makeQueue({ assignedAdminId: 'admin-002' })
    ]);
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({
      queue: makeQueue({ assignedAdminId: 'admin-002', assignmentMethod: 'PROJECT_AFFINITY' }),
      created: true
    });

    await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(queueModel.countPendingManualReviewByAdminIds).not.toHaveBeenCalled();
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedAdminId: 'admin-002',
        assignmentMethod: 'PROJECT_AFFINITY'
      })
    );
  });

  it('uses Redis round-robin when no affinity exists', async () => {
    const disbursement = makeDisbursement();
    vi.mocked(authModel.findUsersByRole).mockResolvedValue([
      { id: 'admin-001', role: 'admin', accountStatus: 'ACTIVE' },
      { id: 'admin-002', role: 'admin', accountStatus: 'ACTIVE' }
    ] as never);
    redisIncrMock.mockResolvedValue(2);
    vi.mocked(redisConfig.getRedisClientIfReady).mockReturnValue({ incr: redisIncrMock } as never);
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({
      queue: makeQueue({ assignedAdminId: 'admin-002', assignmentMethod: 'ROUND_ROBIN' }),
      created: true
    });

    await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(redisIncrMock).toHaveBeenCalledWith('manual_review_queue:assignment_cursor');
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedAdminId: 'admin-002',
        assignmentMethod: 'ROUND_ROBIN'
      })
    );
  });

  it('leaves queue unassigned when no active admin is available', async () => {
    const disbursement = makeDisbursement();
    vi.mocked(authModel.findUsersByRole).mockResolvedValue([]);
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId).mockResolvedValue(null);
    vi.mocked(queueModel.upsertManualReviewQueue).mockResolvedValue({
      queue: makeQueue({ assignedAdminId: null, assignmentMethod: 'UNASSIGNED', assignedAt: null }),
      created: true
    });

    await openManualReviewQueueForDisbursement({
      disbursement,
      reason: 'PayOS failed',
      retryCount: 3,
      source: 'payos_worker'
    });

    expect(notificationService.createUserNotification).not.toHaveBeenCalled();
    expect(queueModel.upsertManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedAdminId: null,
        assignmentMethod: 'UNASSIGNED',
        assignedAt: null
      })
    );
  });

  it('returns paginated pending items without raw beneficiary bank account on list DTO', async () => {
    vi.mocked(queueModel.findPendingManualReviewQueuesPaginated).mockResolvedValue({
      items: [makeQueue()],
      total: 1
    });
    vi.mocked(disbursementModel.findDisbursementsByRequestIds).mockResolvedValue([makeDisbursement()]);

    const result = await getPendingManualReview({ page: 1, limit: 50 });

    expect(result.totalPages).toBe(1);
    expect(result.items[0]?.requestId).toBe('DS-001');
    expect(result.items[0]).not.toHaveProperty('beneficiaryBankAccount');
    expect(disbursementModel.findDisbursementsByRequestIds).toHaveBeenCalledWith(['DS-001']);
  });

  it('masks beneficiary bank account on detail DTO', async () => {
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId).mockResolvedValue(makeQueue());
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    const transferLogModel = await import('../../models/disbursementTransferModel');
    vi.mocked(transferLogModel.findTransferLogsByRequestId).mockResolvedValue([]);
    vi.mocked(auditLogModel.findAuditLogsByRequestId).mockResolvedValue([]);

    const detail = await getManualReviewDetail('DS-001');

    expect(detail.beneficiaryBankAccount.bankAccountNumber).toBe('******7890');
    expect(detail.beneficiaryBankAccount.accountHolderName).toBe('Ng**********');
  });

  it('reveals bank account only on explicit request and audits the access', async () => {
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId).mockResolvedValue(makeQueue());
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    const transferLogModel = await import('../../models/disbursementTransferModel');
    vi.mocked(transferLogModel.findTransferLogsByRequestId).mockResolvedValue([]);
    vi.mocked(auditLogModel.findAuditLogsByRequestId).mockResolvedValue([]);
    vi.mocked(auditLogModel.createAdminAuditLog).mockResolvedValue({} as never);

    const detail = await getManualReviewDetail('DS-001', {
      revealBankAccount: true,
      adminUserId: 'admin-001'
    });

    expect(detail.beneficiaryBankAccount.bankAccountNumber).toBe('1234567890');
    expect(detail.beneficiaryBankAccount.accountHolderName).toBe('Nguyen Van A');
    expect(auditLogModel.createAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MANUAL_BANK_ACCOUNT_VIEW',
      adminUserId: 'admin-001',
      targetRequestId: 'DS-001',
      metadata: expect.objectContaining({ accessMode: 'REVEAL_ON_DEMAND' })
    }));
  });

  it('fails closed when bank account reveal cannot be audited', async () => {
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId).mockResolvedValue(makeQueue());
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    const transferLogModel = await import('../../models/disbursementTransferModel');
    vi.mocked(transferLogModel.findTransferLogsByRequestId).mockResolvedValue([]);
    vi.mocked(auditLogModel.findAuditLogsByRequestId).mockResolvedValue([]);
    vi.mocked(auditLogModel.createAdminAuditLog).mockRejectedValue(new Error('audit database unavailable'));

    await expect(getManualReviewDetail('DS-001', {
      revealBankAccount: true,
      adminUserId: 'admin-001'
    })).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'INTERNAL_ERROR'
    });
  });

  it('returns allowlisted detail logs without provider PII or internal metadata', async () => {
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId).mockResolvedValue(makeQueue());
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    const transferLogModel = await import('../../models/disbursementTransferModel');
    vi.mocked(transferLogModel.findTransferLogsByRequestId).mockResolvedValue([{
      transferLogId: 'TRF-001',
      disbursementRequestId: 'DS-001',
      attemptNumber: 1,
      payosTransferId: 'payos-001',
      providerTransactionId: 'provider-001',
      amount: 100000,
      bankCode: 'VCB',
      bankAccountNumber: '1234567890',
      accountHolderName: 'Nguyen Van A',
      status: 'FAILED',
      errorMessage: 'accountNumber: 1234 567890; holderName: Nguyen Van A',
      responseData: { accountNumber: '1234567890' },
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      completedAt: new Date('2026-08-01T00:00:01.000Z'),
      durationMs: 1000
    }]);
    vi.mocked(auditLogModel.findAuditLogsByRequestId).mockResolvedValue([{
      auditId: 'AUD-001',
      adminUserId: 'admin-001',
      action: 'MANUAL_APPROVE',
      targetRequestId: 'DS-001',
      reason: null,
      metadata: { newIdempotencyKey: 'secret-key', previousError: 'accountNumber: 1234567890' },
      createdAt: new Date('2026-08-01T00:00:00.000Z')
    }]);

    const detail = await getManualReviewDetail('DS-001');

    expect(detail.transferLogs[0]).toEqual(expect.objectContaining({
      transferLogId: 'TRF-001',
      errorMessage: expect.not.stringContaining('1234567890')
    }));
    expect(detail.transferLogs[0]).not.toHaveProperty('responseData');
    expect(detail.transferLogs[0]).not.toHaveProperty('bankAccountNumber');
    expect(detail.auditLogs[0]).not.toHaveProperty('metadata');
    expect(detail.auditLogs[0]).not.toHaveProperty('newIdempotencyKey');
  });

  it('blocks manual approve when PayOS is still PROCESSING', async () => {
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(makeQueue({ actionLockId: 'lock-001' }));
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: true,
      transferId: 'payos-001',
      providerTransactionId: 'provider-001',
      transferStatus: 'PROCESSING',
      errorMessage: null,
      rawPayload: {}
    });

    await expect(manualApprove('DS-001', 'admin-001')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'CONFLICT'
    });
    expect(transferQueue.enqueueDisbursementTransfer).not.toHaveBeenCalled();
    expect(queueModel.releaseManualReviewActionLease).toHaveBeenCalledWith('MRQ-001', expect.any(String));
  });

  it('approves safely when provider is FAILED and resolves queue once', async () => {
    const queue = makeQueue({ actionLockId: 'lock-001' });
    const disbursement = makeDisbursement();
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(queue);
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(disbursement);
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: true,
      transferId: 'payos-001',
      providerTransactionId: 'provider-001',
      transferStatus: 'FAILED',
      errorMessage: 'failed',
      rawPayload: {}
    });
    vi.mocked(transferQueue.removePendingJobsByRequestId).mockResolvedValue(0);
    vi.mocked(disbursementModel.updateDisbursementByRequestIdWithCondition).mockResolvedValue(
      makeDisbursement({ payosTransferStatus: 'PROCESSING', payosTransferAttemptCount: 0 })
    );
    vi.mocked(transferQueue.enqueueDisbursementTransfer).mockResolvedValue({ enqueued: true, jobId: 'job-001' });
    vi.mocked(queueModel.resolveManualReviewQueue).mockResolvedValue(makeQueue({ status: 'APPROVED' }));
    vi.mocked(auditLogModel.createAdminAuditLog).mockResolvedValue({} as never);

    const result = await manualApprove('DS-001', 'admin-001');

    expect(result.payosTransferStatus).toBe('PROCESSING');
    expect(transferQueue.enqueueDisbursementTransfer).toHaveBeenCalledWith(
      'DS-001',
      1,
      expect.stringContaining('manual-approve-DS-001-')
    );
    expect(queueModel.resolveManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 'MRQ-001', status: 'APPROVED', adminUserId: 'admin-001' })
    );
  });

  it('compensates approve state when audit persistence fails', async () => {
    const queue = makeQueue({ actionLockId: 'lock-001' });
    const disbursement = makeDisbursement();
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(queue);
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(disbursement);
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: false,
      transferId: null,
      providerTransactionId: null,
      transferStatus: 'FAILED',
      errorMessage: null,
      rawPayload: {}
    });
    vi.mocked(transferQueue.removePendingJobsByRequestId).mockResolvedValue(0);
    vi.mocked(disbursementModel.updateDisbursementByRequestIdWithCondition)
      .mockResolvedValueOnce(makeDisbursement({ payosTransferStatus: 'PROCESSING', payosTransferAttemptCount: 0 }))
      .mockResolvedValueOnce(disbursement);
    vi.mocked(transferQueue.enqueueDisbursementTransfer).mockResolvedValue({ enqueued: true, jobId: 'job-001' });
    vi.mocked(auditLogModel.createAdminAuditLog).mockRejectedValue(new Error('audit database unavailable'));

    await expect(manualApprove('DS-001', 'admin-001')).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'INTERNAL_ERROR'
    });

    expect(transferQueue.removePendingJobsByRequestId).toHaveBeenCalledTimes(2);
    expect(disbursementModel.updateDisbursementByRequestIdWithCondition).toHaveBeenNthCalledWith(
      2,
      'DS-001',
      expect.objectContaining({ payosTransferStatus: 'PROCESSING' }),
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
    expect(queueModel.resolveManualReviewQueue).not.toHaveBeenCalled();
    expect(queueModel.releaseManualReviewActionLease).toHaveBeenCalledWith('MRQ-001', expect.any(String));
  });

  it('rolls back approve state and releases lease when enqueue fails', async () => {
    const queue = makeQueue({ actionLockId: 'lock-001' });
    const disbursement = makeDisbursement();
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(queue);
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(disbursement);
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: false,
      transferId: null,
      providerTransactionId: null,
      transferStatus: 'FAILED',
      errorMessage: null,
      rawPayload: {}
    });
    vi.mocked(transferQueue.removePendingJobsByRequestId).mockResolvedValue(0);
    vi.mocked(disbursementModel.updateDisbursementByRequestIdWithCondition)
      .mockResolvedValueOnce(makeDisbursement({ payosTransferStatus: 'PROCESSING', payosTransferAttemptCount: 0 }))
      .mockResolvedValueOnce(disbursement);
    vi.mocked(transferQueue.enqueueDisbursementTransfer).mockResolvedValue({ enqueued: false, jobId: undefined });

    await expect(manualApprove('DS-001', 'admin-001')).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'INTERNAL_ERROR'
    });

    expect(disbursementModel.updateDisbursementByRequestIdWithCondition).toHaveBeenNthCalledWith(
      2,
      'DS-001',
      expect.objectContaining({ payosTransferStatus: 'PROCESSING' }),
      expect.objectContaining({
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferAttemptCount: 3,
        transferIdempotencyKey: 'disbursement-DS-001'
      })
    );
    expect(queueModel.releaseManualReviewActionLease).toHaveBeenCalledWith('MRQ-001', expect.any(String));
  });

  it('compensates approve state when queue resolve fails after enqueue succeeds', async () => {
    const queue = makeQueue({ actionLockId: 'lock-001' });
    const disbursement = makeDisbursement();
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(queue);
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(disbursement);
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: false,
      transferId: null,
      providerTransactionId: null,
      transferStatus: 'FAILED',
      errorMessage: null,
      rawPayload: {}
    });
    vi.mocked(transferQueue.removePendingJobsByRequestId).mockResolvedValue(0);
    vi.mocked(disbursementModel.updateDisbursementByRequestIdWithCondition)
      .mockResolvedValueOnce(makeDisbursement({ payosTransferStatus: 'PROCESSING', payosTransferAttemptCount: 0 }))
      .mockResolvedValueOnce(disbursement);
    vi.mocked(transferQueue.enqueueDisbursementTransfer).mockResolvedValue({ enqueued: true, jobId: 'job-001' });
    vi.mocked(queueModel.resolveManualReviewQueue).mockResolvedValue(null);

    await expect(manualApprove('DS-001', 'admin-001')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_STATUS_TRANSITION'
    });

    expect(transferQueue.removePendingJobsByRequestId).toHaveBeenCalledTimes(2);
    expect(disbursementModel.updateDisbursementByRequestIdWithCondition).toHaveBeenNthCalledWith(
      2,
      'DS-001',
      expect.objectContaining({ payosTransferStatus: 'PROCESSING' }),
      expect.objectContaining({
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferAttemptCount: 3,
        transferIdempotencyKey: 'disbursement-DS-001'
      })
    );
    expect(queueModel.releaseManualReviewActionLease).toHaveBeenCalledWith('MRQ-001', expect.any(String));
  });

  it('blocks manual reject when PayOS is already SUCCESS', async () => {
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(makeQueue({ actionLockId: 'lock-001' }));
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(makeDisbursement());
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: true,
      transferId: 'payos-001',
      providerTransactionId: 'provider-001',
      transferStatus: 'SUCCESS',
      errorMessage: null,
      rawPayload: {}
    });

    await expect(manualReject('DS-001', 'admin-001', 'Reason is long enough')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'CONFLICT'
    });
    expect(disbursementModel.updateDisbursementByRequestIdWithCondition).not.toHaveBeenCalled();
    expect(queueModel.releaseManualReviewActionLease).toHaveBeenCalledWith('MRQ-001', expect.any(String));
  });

  it('rejects safely when provider has no active transfer and notifies only the organization', async () => {
    const queue = makeQueue({ actionLockId: 'lock-001' });
    const disbursement = makeDisbursement();
    const rejected = makeDisbursement({ status: 'REJECTED', payosTransferStatus: 'FAILED' });
    vi.mocked(queueModel.acquireManualReviewActionLease).mockResolvedValue(queue);
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockResolvedValue(disbursement);
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockResolvedValue({
      found: false,
      transferId: null,
      providerTransactionId: null,
      transferStatus: 'FAILED',
      errorMessage: null,
      rawPayload: {}
    });
    vi.mocked(transferQueue.removePendingJobsByRequestId).mockResolvedValue(0);
    vi.mocked(disbursementModel.updateDisbursementByRequestIdWithCondition).mockResolvedValue(rejected);
    vi.mocked(queueModel.resolveManualReviewQueue).mockResolvedValue(makeQueue({ status: 'REJECTED' }));
    vi.mocked(auditLogModel.createAdminAuditLog).mockResolvedValue({} as never);
    vi.mocked(donationModel.findDonationsByProjectId).mockResolvedValue([
      {
        transactionHash: '0x001',
        projectId: 'project-001',
        donorAddress: '0xdonor000000000000000000000000000000000001',
        amount: 1000,
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
        isAnonymous: false,
        blockNumber: 1,
        donationStatus: 'INDEXED',
        onChainConfirmedAt: new Date('2026-08-01T00:00:00.000Z'),
        indexedAt: new Date('2026-08-01T00:00:00.000Z'),
        correlationId: 'donation-001',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z')
      }
    ]);
    vi.mocked(authModel.findUsersByWalletAddressList).mockResolvedValue([
      { id: 'donor-001', role: 'donor', accountStatus: 'ACTIVE' } as never
    ]);

    const result = await manualReject('DS-001', 'admin-001', 'Invalid beneficiary evidence');

    expect(result.status).toBe('REJECTED');
    expect(queueModel.resolveManualReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REJECTED', reason: 'Invalid beneficiary evidence' })
    );
    expect(notificationService.createUserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'org-001',
        deduplicationKey: 'MANUAL_REJECT_NOTIFY:MRQ-001:org-001'
      })
    );
    expect(notificationService.createUserNotification).toHaveBeenCalledTimes(1);
    expect(authModel.findUsersByWalletAddressList).not.toHaveBeenCalled();
    expect(donationModel.findDonationsByProjectId).not.toHaveBeenCalled();
    expect(socketEmitMock).toHaveBeenCalledWith(
      'transfer:updated',
      expect.objectContaining({ requestId: 'DS-001', payosTransferStatus: 'FAILED' })
    );
  });

  it('rejects invalid manual reject reason before acquiring lease', async () => {
    await expect(manualReject('DS-001', 'admin-001', 'too short')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR'
    });
    expect(queueModel.acquireManualReviewActionLease).not.toHaveBeenCalled();
  });

  it('reconciles missing queues and continues after item failure', async () => {
    vi.mocked(disbursementModel.findDisbursementsInManualReview).mockResolvedValue([
      makeDisbursement({ requestId: 'DS-001' }),
      makeDisbursement({ requestId: 'DS-002' }),
      makeDisbursement({ requestId: 'DS-003' })
    ]);
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId)
      .mockResolvedValueOnce(makeQueue({ disbursementRequestId: 'DS-001' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(queueModel.findLatestManualReviewQueueByRequestId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(queueModel.upsertManualReviewQueue)
      .mockResolvedValueOnce({ queue: makeQueue({ disbursementRequestId: 'DS-002' }), created: true })
      .mockRejectedValueOnce(new Error('db unavailable'));

    const result = await reconcileMissingManualReviewQueues(10);

    expect(result).toEqual({ scanned: 3, opened: 1, skipped: 1, failed: 1, hasMore: false });
    expect(disbursementModel.findDisbursementsInManualReview).toHaveBeenCalledWith(10);
  });

  it('persists a bounded reconciliation cursor when the run reaches its scan limit', async () => {
    const redisGetMock = vi.fn().mockResolvedValue(null);
    const redisSetMock = vi.fn().mockResolvedValue('OK');
    const redisDelMock = vi.fn().mockResolvedValue(1);
    vi.mocked(redisConfig.getRedisClientIfReady).mockReturnValue({
      get: redisGetMock,
      set: redisSetMock,
      del: redisDelMock
    } as never);
    vi.mocked(disbursementModel.findDisbursementsInManualReview).mockResolvedValue([
      makeDisbursement({ requestId: 'DS-001' })
    ]);
    vi.mocked(queueModel.findPendingManualReviewQueueByRequestId).mockResolvedValue(makeQueue());

    const result = await reconcileMissingManualReviewQueues({ pageSize: 1, maxItems: 1 });

    expect(result).toEqual({ scanned: 1, opened: 0, skipped: 1, failed: 0, hasMore: true });
    expect(redisSetMock).toHaveBeenCalledWith(
      'manual_review_queue:reconciliation_cursor',
      expect.stringContaining('DS-001'),
      expect.objectContaining({ EX: expect.any(Number) })
    );
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('returns escalation candidates without marking them before notification succeeds', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const firstQueue = makeQueue({ queueId: 'MRQ-001' });
    const secondQueue = makeQueue({ queueId: 'MRQ-002' });
    vi.mocked(queueModel.claimManualReviewEscalationCandidates).mockResolvedValue([firstQueue, secondQueue]);

    const result = await claimManualReviewEscalationCandidates(now, 100);

    expect(result).toHaveLength(2);
    expect(result[0]?.queueId).toBe('MRQ-001');
    expect(queueModel.claimManualReviewEscalationCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        now,
        limit: 100,
        claimId: expect.any(String),
        claimExpiresAt: new Date('2026-08-01T00:05:00.000Z')
      })
    );
    expect(queueModel.markManualReviewQueueEscalated).not.toHaveBeenCalled();
  });

  it('marks escalation only after notification is created', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(queueModel.markManualReviewQueueEscalated).mockResolvedValue(makeQueue({ escalatedAt: now }));

    const result = await markManualReviewEscalationNotified('MRQ-001', now);

    expect(result?.escalatedAt).toEqual(now);
    expect(queueModel.markManualReviewQueueEscalated).toHaveBeenCalledWith('MRQ-001', now);
  });
});
