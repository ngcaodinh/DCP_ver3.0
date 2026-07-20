/**
 * Unit tests cho payosTransferWorker.
 * Test cac ham processTransferJob, pollTransferUntilFinal, moveToManualReview, isDisbursementTimedOut va cac helper functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============ Mock external modules ============

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockJobMoveToDelayed = vi.fn();
const mockJobRemove = vi.fn();
const mockQueueGetWaiting = vi.fn();
const mockQueueGetDelayed = vi.fn();
const mockQueueAdd = vi.fn();
const mockQueueProcess = vi.fn();
const mockQueueOn = vi.fn();

const mockQueueInstance = {
  add: mockQueueAdd,
  process: mockQueueProcess,
  on: mockQueueOn,
  getWaiting: mockQueueGetWaiting,
  getDelayed: mockQueueGetDelayed,
};

process.env.DISBURSEMENT_TRANSFER_POLL_INTERVAL_MS = '1';
process.env.DISBURSEMENT_TRANSFER_POLL_MAX_ATTEMPTS = '3';

vi.mock('../../queues/disbursementTransferQueue', () => ({
  PAYOS_TRANSFER_RETRY_DELAYS_MS: [60_000, 300_000, 1_800_000],
  getDisbursementTransferQueue: vi.fn(() => mockQueueInstance),
  enqueueDisbursementTransfer: vi.fn(() => ({ jobId: 'job-123', enqueued: true })),
  removePendingJobsByRequestId: vi.fn(() => Promise.resolve(0)),
  DisbursementTransferJobData: {},
}));

vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: vi.fn(),
  updateDisbursementByRequestId: vi.fn(),
}));

vi.mock('../../models/disbursementTransferModel', () => ({
  createTransferLog: vi.fn(),
  updateTransferLogById: vi.fn(),
}));

vi.mock('../../services/payosService', () => ({
  createPayosTransfer: vi.fn(),
  getPayosTransferStatusByReferenceId: vi.fn(),
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn(),
}));

vi.mock('../../services/disbursementService', () => ({
  processDisbursementTransferWebhook: vi.fn(),
}));

import * as disbursementModel from '../../models/disbursementModel';
import * as disbursementTransferModel from '../../models/disbursementTransferModel';
import * as payosService from '../../services/payosService';
import * as notificationService from '../../services/notificationService';
import * as disbursementService from '../../services/disbursementService';
import * as disbursementTransferQueue from '../../queues/disbursementTransferQueue';
import type { DisbursementTransferLogRecord } from '../../models/disbursementTransferModel';
import type { Job } from 'bull';

// ============ Test helpers ============

type MockDisbursement = {
  requestId: string;
  onChainRequestId: number;
  projectId: string;
  organizationId: string;
  beneficiaryWalletAddress: string;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  requiredApprovals: number;
  raisedRatioBpsAtCreation: number;
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  status: string;
  approvals: Array<{
    signerRole: string;
    signerUserId: string;
    signerAddress: string;
    transactionHash: string;
    signedAt: Date;
    comment?: string;
  }>;
  rejection: { signerRole: string; signerUserId: string; signerAddress: string; reason: string; rejectedAt: Date } | null;
  timeoutDeadline: Date | null;
  payosTransferId: string | null;
  payosTransferStatus: string | null;
  payosTransferAttemptCount: number | null;
  payosTransferLastError: string | null;
  transferIdempotencyKey: string | null;
  transactionHash: string | null;
  finalizeTransactionHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date | null;
  completedAt: Date | null;
};

function makeMockDisbursement(overrides: Partial<MockDisbursement> & { requestId: string }): MockDisbursement {
  const base: MockDisbursement = {
    onChainRequestId: 1,
    projectId: 'proj-001',
    organizationId: 'org-001',
    beneficiaryWalletAddress: '0x0000000000000000000000000000000000000000',
    beneficiaryBankAccount: {
      bankName: 'VIETCOMBANK',
      bankAccountNumber: '1234567890',
      accountHolderName: 'Test User',
      branchName: 'Ho Chi Minh',
    },
    requestMode: 'NORMAL',
    emergencyReason: null,
    requiredApprovals: 2,
    raisedRatioBpsAtCreation: 5000,
    amount: 100000,
    usagePurpose: 'Test disbursement',
    evidenceCid: 'QmTest123',
    status: 'APPROVED',
    approvals: [],
    rejection: null,
    timeoutDeadline: null,
    payosTransferId: null,
    payosTransferStatus: null,
    payosTransferAttemptCount: 0,
    payosTransferLastError: null,
    transferIdempotencyKey: null,
    transactionHash: null,
    finalizeTransactionHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiredAt: null,
    completedAt: null,
    requestId: 'DS-TEST-001',
  };
  return Object.assign(base, overrides);
}

function makeMockJob(data: {
  requestId: string;
  attemptNumber: number;
  idempotencyKey: string;
}): Job {
  return {
    id: 'job-123',
    data,
    moveToDelayed: mockJobMoveToDelayed,
    remove: mockJobRemove,
  } as unknown as Job;
}

function makeMockTransferLog(overrides: Partial<DisbursementTransferLogRecord> & { transferLogId: string }): DisbursementTransferLogRecord {
  const base: DisbursementTransferLogRecord = {
    transferLogId: 'TRF-001',
    disbursementRequestId: 'DS-TEST-001',
    attemptNumber: 1,
    payosTransferId: null,
    providerTransactionId: null,
    amount: 100000,
    bankCode: '970436',
    bankAccountNumber: '****6789',
    accountHolderName: 'Te****',
    status: 'PROCESSING',
    errorMessage: null,
    responseData: null,
    startedAt: new Date(),
    completedAt: null,
    durationMs: null,
  };
  return Object.assign(base, overrides);
}

// ============ Helper function tests ============

describe('payosTransferWorker - Helper functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractErrorMessage', () => {
    it('should return error message from Error instance', async () => {
      const { extractErrorMessage } = await import('../../workers/payosTransferWorker');
      const error = new Error('PayOS API failed');
      expect(extractErrorMessage(error)).toBe('PayOS API failed');
    });

    it('should return string error as-is', async () => {
      const { extractErrorMessage } = await import('../../workers/payosTransferWorker');
      expect(extractErrorMessage('Simple error string')).toBe('Simple error string');
    });

    it('should return stringified unknown object', async () => {
      const { extractErrorMessage } = await import('../../workers/payosTransferWorker');
      expect(extractErrorMessage({ reason: 'unknown' })).toBe('[object Object]');
    });
  });

  describe('maskBankAccount', () => {
    it('should mask all but last 4 digits', async () => {
      const { maskBankAccount } = await import('../../workers/payosTransferWorker');
      expect(maskBankAccount('1234567890')).toBe('******7890');
    });

    it('should return **** for accounts <= 4 digits', async () => {
      const { maskBankAccount } = await import('../../workers/payosTransferWorker');
      expect(maskBankAccount('1234')).toBe('****');
      expect(maskBankAccount('123')).toBe('****');
      expect(maskBankAccount('')).toBe('****');
    });

    it('should handle exactly 5 digits', async () => {
      const { maskBankAccount } = await import('../../workers/payosTransferWorker');
      expect(maskBankAccount('12345')).toBe('*2345');
    });
  });

  describe('maskAccountHolderName', () => {
    it('should mask all but first 2 characters', async () => {
      const { maskAccountHolderName } = await import('../../workers/payosTransferWorker');
      expect(maskAccountHolderName('Nguyen Van A')).toBe('Ng**********');
    });

    it('should return ** for names <= 2 characters', async () => {
      const { maskAccountHolderName } = await import('../../workers/payosTransferWorker');
      expect(maskAccountHolderName('AB')).toBe('**');
      expect(maskAccountHolderName('A')).toBe('**');
      expect(maskAccountHolderName('')).toBe('**');
    });

    it('should handle exactly 3 characters', async () => {
      const { maskAccountHolderName } = await import('../../workers/payosTransferWorker');
      expect(maskAccountHolderName('Bob')).toBe('Bo*');
    });
  });

  describe('sanitizePayosResponseForLog', () => {
    it('should redact sensitive keys', async () => {
      const { sanitizePayosResponseForLog } = await import('../../workers/payosTransferWorker');
      const input = {
        accountNumber: '1234567890',
        accountHolderName: 'Test User',
        amount: 100000,
        status: 'SUCCESS',
      };
      const result = sanitizePayosResponseForLog(input);
      expect(result.accountNumber).toBe('[REDACTED]');
      expect(result.accountHolderName).toBe('[REDACTED]');
      expect(result.amount).toBe(100000);
      expect(result.status).toBe('SUCCESS');
    });

    it('should handle non-object input gracefully', async () => {
      const { sanitizePayosResponseForLog } = await import('../../workers/payosTransferWorker');
      expect(sanitizePayosResponseForLog(null)).toEqual({});
      expect(sanitizePayosResponseForLog('string' as unknown as null)).toEqual({});
      expect(sanitizePayosResponseForLog(undefined)).toEqual({});
    });

    it('should recursively sanitize nested objects', async () => {
      const { sanitizePayosResponseForLog } = await import('../../workers/payosTransferWorker');
      const input = {
        transfer: {
          accountNumber: '1234567890',
          description: 'Test payment',
        },
        amount: 50000,
      };
      const result = sanitizePayosResponseForLog(input) as { transfer: Record<string, unknown>; amount: number };
      expect(result.transfer.accountNumber).toBe('[REDACTED]');
      expect(result.transfer.description).toBe('Test payment');
      expect(result.amount).toBe(50000);
    });

    it('should match case-insensitive key patterns', async () => {
      const { sanitizePayosResponseForLog } = await import('../../workers/payosTransferWorker');
      const input = {
        ACCOUNT_NUMBER: '1234567890',
        AccountHolderName: 'Test User',
        toAccountNumber: '0987654321',
      };
      const result = sanitizePayosResponseForLog(input);
      expect(result.ACCOUNT_NUMBER).toBe('[REDACTED]');
      expect(result.AccountHolderName).toBe('[REDACTED]');
      expect(result.toAccountNumber).toBe('[REDACTED]');
    });
  });
});

// ============ isDisbursementTimedOut tests ============

describe('payosTransferWorker - isDisbursementTimedOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return false when no deadline set', async () => {
    const { isDisbursementTimedOut } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', timeoutDeadline: null })
    );
    const result = await isDisbursementTimedOut('DS-TEST-001');
    expect(result).toBe(false);
  });

  it('should return false when before deadline', async () => {
    const { isDisbursementTimedOut } = await import('../../workers/payosTransferWorker');
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', timeoutDeadline: futureDate })
    );
    const result = await isDisbursementTimedOut('DS-TEST-001');
    expect(result).toBe(false);
  });

  it('should return true when after deadline', async () => {
    const { isDisbursementTimedOut } = await import('../../workers/payosTransferWorker');
    const pastDate = new Date(Date.now() - 60 * 1000);
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', timeoutDeadline: pastDate })
    );
    const result = await isDisbursementTimedOut('DS-TEST-001');
    expect(result).toBe(true);
  });

  it('should return false when disbursement not found', async () => {
    const { isDisbursementTimedOut } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await isDisbursementTimedOut('DS-NOT-FOUND');
    expect(result).toBe(false);
  });
});

// ============ pollTransferUntilFinal tests ============

describe('payosTransferWorker - pollTransferUntilFinal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockReset();
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return SUCCESS immediately when disbursement already COMPLETED', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' })
    );
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('SUCCESS');
    expect(payosService.getPayosTransferStatusByReferenceId).not.toHaveBeenCalled();
  });

  it('should return SUCCESS immediately when disbursement already has payosTransferStatus SUCCESS', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'SUCCESS' })
    );
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('SUCCESS');
    expect(payosService.getPayosTransferStatusByReferenceId).not.toHaveBeenCalled();
  });

  it('should return FAILED immediately when disbursement is in MANUAL_REVIEW', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('FAILED');
    expect(payosService.getPayosTransferStatusByReferenceId).not.toHaveBeenCalled();
  });

  it('should return SUCCESS when PayOS returns SUCCESS during polling', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: null }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'SUCCESS' }));
    (payosService.getPayosTransferStatusByReferenceId as ReturnType<typeof vi.fn>).mockResolvedValue({
      found: true,
      transferStatus: 'SUCCESS',
    });
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('SUCCESS');
  });

  it('should return FAILED when PayOS returns FAILED during polling', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: null }));
    (payosService.getPayosTransferStatusByReferenceId as ReturnType<typeof vi.fn>).mockResolvedValue({
      found: true,
      transferStatus: 'FAILED',
    });
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('FAILED');
  });

  it('should return PROCESSING after max polling attempts exhausted', async () => {
    const { pollTransferUntilFinal } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: null })
    );
    (payosService.getPayosTransferStatusByReferenceId as ReturnType<typeof vi.fn>).mockResolvedValue({
      found: false,
    });
    const result = await pollTransferUntilFinal('DS-TEST-001', 'transfer-123');
    expect(result).toBe('PROCESSING');
    expect(payosService.getPayosTransferStatusByReferenceId).toHaveBeenCalledTimes(3);
  });
});

// ============ moveToManualReview tests ============

describe('payosTransferWorker - moveToManualReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update disbursement to MANUAL_REVIEW and remove pending jobs', async () => {
    const { moveToManualReview } = await import('../../workers/payosTransferWorker');
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await moveToManualReview('DS-TEST-001', 'PayOS API error', 'transfer-456');

    expect(disbursementModel.updateDisbursementByRequestId).toHaveBeenCalledWith(
      'DS-TEST-001',
      expect.objectContaining({
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferLastError: 'PayOS API error',
        payosTransferId: 'transfer-456',
      })
    );
    expect(disbursementTransferQueue.removePendingJobsByRequestId).toHaveBeenCalledWith('DS-TEST-001');
    expect(notificationService.createUserNotification).toHaveBeenCalled();
  });

  it('should be idempotent when called multiple times', async () => {
    const { moveToManualReview } = await import('../../workers/payosTransferWorker');
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await moveToManualReview('DS-TEST-001', 'Error 1');
    await moveToManualReview('DS-TEST-001', 'Error 2');

    // Should be called twice (idempotent, no throwing)
    expect(disbursementModel.updateDisbursementByRequestId).toHaveBeenCalledTimes(2);
    expect(disbursementTransferQueue.removePendingJobsByRequestId).toHaveBeenCalledTimes(2);
  });

  it('should handle case where finalTransferId is undefined', async () => {
    const { moveToManualReview } = await import('../../workers/payosTransferWorker');
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await moveToManualReview('DS-TEST-001', 'Timeout error');

    // When finalTransferId is undefined, payosTransferId should not be set in the update payload
    const updateCall = (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mock.calls[0];
    const updatePayload = updateCall[1] as Record<string, unknown>;
    expect(updatePayload.payosTransferStatus).toBe('MANUAL_REVIEW');
    expect('payosTransferId' in updatePayload && updatePayload.payosTransferId !== undefined).toBe(false);
  });
});

// ============ processTransferJob tests ============

describe('payosTransferWorker - processTransferJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(disbursementModel.findDisbursementByRequestId).mockReset();
    vi.mocked(disbursementModel.updateDisbursementByRequestId).mockReset();
    vi.mocked(disbursementTransferModel.createTransferLog).mockReset();
    vi.mocked(disbursementTransferModel.updateTransferLogById).mockReset();
    vi.mocked(payosService.createPayosTransfer).mockReset();
    vi.mocked(payosService.getPayosTransferStatusByReferenceId).mockReset();
    vi.mocked(disbursementService.processDisbursementTransferWebhook).mockReset();
    vi.mocked(disbursementTransferQueue.removePendingJobsByRequestId).mockReset();
    vi.mocked(notificationService.createUserNotification).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should skip job when disbursement not found', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const mockJob = makeMockJob({ requestId: 'DS-NOT-FOUND', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);
    expect(disbursementModel.updateDisbursementByRequestId).not.toHaveBeenCalled();
    expect(payosService.createPayosTransfer).not.toHaveBeenCalled();
  });

  it('should skip job when disbursement status is PENDING', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'PENDING' })
    );
    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);
    expect(payosService.createPayosTransfer).not.toHaveBeenCalled();
  });

  it('should skip job when disbursement is already COMPLETED', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' })
    );
    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);
    expect(payosService.createPayosTransfer).not.toHaveBeenCalled();
  });

  it('should skip job when disbursement already has payosTransferStatus SUCCESS', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'SUCCESS' })
    );
    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);
    expect(payosService.createPayosTransfer).not.toHaveBeenCalled();
  });

  it('should move to manual review when disbursement is timed out', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    const pastDeadline = new Date(Date.now() - 60 * 1000);
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', timeoutDeadline: pastDeadline }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', timeoutDeadline: pastDeadline }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(payosService.createPayosTransfer).not.toHaveBeenCalled();
  });

  it('should handle PayOS SUCCESS on first call', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'SUCCESS' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      transferId: 'payos-123',
      providerTransactionId: 'prov-456',
      transferStatus: 'SUCCESS',
      rawPayload: {},
    });
    (disbursementService.processDisbursementTransferWebhook as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' })
    );

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(payosService.createPayosTransfer).toHaveBeenCalled();
    expect(disbursementService.processDisbursementTransferWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'DS-TEST-001', status: 'SUCCESS' }),
      expect.objectContaining({ skipChecksumVerify: true, source: 'internal_poll' })
    );
  });

  it('should handle PayOS FAILED - move to manual review when max attempts reached', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'FAILED', errorMessage: 'PayOS failed' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      transferId: 'payos-123',
      providerTransactionId: 'prov-456',
      transferStatus: 'FAILED',
      rawPayload: { message: 'PayOS failed' },
    });
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Attempt 3 = max, so should move to manual review
    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 3, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(disbursementModel.updateDisbursementByRequestId).toHaveBeenCalledWith(
      'DS-TEST-001',
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
  });

  it('should handle PayOS PROCESSING → polling SUCCESS', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'PROCESSING' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'SUCCESS' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'PROCESSING' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      transferId: 'payos-123',
      providerTransactionId: 'prov-456',
      transferStatus: 'PROCESSING',
      rawPayload: {},
    });
    (payosService.getPayosTransferStatusByReferenceId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: true, transferStatus: 'SUCCESS' });
    (disbursementService.processDisbursementTransferWebhook as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' })
    );

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(disbursementService.processDisbursementTransferWebhook).toHaveBeenCalled();
  });

  it('should handle PayOS PROCESSING → polling FAILED', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'PROCESSING' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'FAILED' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      transferId: 'payos-123',
      providerTransactionId: 'prov-456',
      transferStatus: 'PROCESSING',
      rawPayload: {},
    });
    // Exhaust polling with no final status
    (payosService.getPayosTransferStatusByReferenceId as ReturnType<typeof vi.fn>).mockResolvedValue({ found: false });
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'MANUAL_REVIEW' })
    );
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 3, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(disbursementModel.updateDisbursementByRequestId).toHaveBeenCalledWith(
      'DS-TEST-001',
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
  });

  it('should handle exception from createPayosTransfer and move to manual review at max attempts', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'PROCESSING' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'FAILED', errorMessage: 'Network error' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'MANUAL_REVIEW' })
    );
    (disbursementTransferQueue.removePendingJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (notificationService.createUserNotification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 3, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    expect(disbursementModel.updateDisbursementByRequestId).toHaveBeenCalledWith(
      'DS-TEST-001',
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
    expect(disbursementTransferModel.updateTransferLogById).toHaveBeenCalledWith(
      'TRF-001',
      expect.objectContaining({ status: 'FAILED', errorMessage: 'Network error' })
    );
  });

  it('should not move to manual review when createPayosTransfer throws but attempts < max', async () => {
    const { processTransferJob } = await import('../../workers/payosTransferWorker');
    (disbursementModel.findDisbursementByRequestId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED' }))
      .mockResolvedValueOnce(makeMockDisbursement({ requestId: 'DS-TEST-001', status: 'APPROVED', payosTransferStatus: 'PROCESSING' }));
    (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockDisbursement({ requestId: 'DS-TEST-001', payosTransferStatus: 'PROCESSING' })
    );
    (disbursementTransferModel.createTransferLog as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001' })
    );
    (disbursementTransferModel.updateTransferLogById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockTransferLog({ transferLogId: 'TRF-001', status: 'FAILED', errorMessage: 'Temporary error' })
    );
    (payosService.createPayosTransfer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Temporary error'));

    const mockJob = makeMockJob({ requestId: 'DS-TEST-001', attemptNumber: 1, idempotencyKey: 'key-1' });
    await processTransferJob(mockJob);

    // Should NOT update to MANUAL_REVIEW when attempts < max
    const manualReviewCalls = (disbursementModel.updateDisbursementByRequestId as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1]?.payosTransferStatus === 'MANUAL_REVIEW'
    );
    expect(manualReviewCalls.length).toBe(0);
  });
});

// ============ Integration: startPayosTransferWorker ============

describe('payosTransferWorker - startPayosTransferWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register process handler and event listeners', async () => {
    const { startPayosTransferWorker } = await import('../../workers/payosTransferWorker');
    startPayosTransferWorker();
    expect(mockQueueProcess).toHaveBeenCalledWith(expect.any(Function));
    expect(mockQueueOn).toHaveBeenCalledWith('completed', expect.any(Function));
  });
});
