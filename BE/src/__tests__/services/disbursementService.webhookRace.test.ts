import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DisbursementRecord } from '../../models/disbursementModel';

const mockFinalizeDisbursement = vi.hoisted(() => vi.fn());
const mockRecordBlockchainTransaction = vi.hoisted(() => vi.fn());
const mockFindDisbursementByRequestId = vi.hoisted(() => vi.fn());
const mockUpdateDisbursementByRequestIdWithCondition = vi.hoisted(() => vi.fn());
const mockRemovePendingJobsByRequestId = vi.hoisted(() => vi.fn());
const mockOpenManualReviewQueueForDisbursement = vi.hoisted(() => vi.fn());

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn(),
    Wallet: vi.fn(),
    Contract: vi.fn(() => ({
      finalizeDisbursement: mockFinalizeDisbursement
    })),
    Interface: vi.fn(() => ({ parseLog: vi.fn(() => null) }))
  }
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../utils/blockchainMetrics', () => ({
  recordBlockchainTransaction: mockRecordBlockchainTransaction
}));

vi.mock('../../models/disbursementModel', () => ({
  createDisbursementRecord: vi.fn(),
  findDisbursementByPayosTransferId: vi.fn(() => null),
  findDisbursementByRequestId: mockFindDisbursementByRequestId,
  findDisbursementsByOrganizationId: vi.fn(),
  findDisbursementsByProjectId: vi.fn(),
  findDisbursementsByStatus: vi.fn(),
  findLatestDisbursements: vi.fn(),
  findPendingDisbursementByBeneficiary: vi.fn(),
  updateDisbursementByRequestId: vi.fn(),
  updateDisbursementByRequestIdWithCondition: mockUpdateDisbursementByRequestIdWithCondition
}));

vi.mock('../../models/authModel', () => ({
  findUserById: vi.fn(),
  updateUser: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  findProjectById: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn()
}));

vi.mock('../../services/payosService', () => ({
  getPayosTransferStatusByReferenceId: vi.fn(),
  verifyPayosTransferWebhookChecksum: vi.fn(() => true)
}));

vi.mock('../../queues/disbursementTransferQueue', () => ({
  removePendingJobsByRequestId: mockRemovePendingJobsByRequestId
}));

vi.mock('../../workers/payosTransferWorker', () => ({
  triggerPayosTransferForApprovedDisbursement: vi.fn()
}));

vi.mock('../../services/manualReviewService', () => ({
  openManualReviewQueueForDisbursement: mockOpenManualReviewQueueForDisbursement
}));

vi.mock('../../services/zeroDevService', () => ({
  createKernelClientFromEncryptedOwnerKey: vi.fn()
}));

import { processDisbursementTransferWebhook } from '../../services/disbursementService';
import { recordBlockchainTransaction } from '../../utils/blockchainMetrics';

/** Tạo disbursement fixture đủ field cho webhook transfer race tests. */
function makeDisbursement(overrides: Partial<DisbursementRecord> = {}): DisbursementRecord {
  const now = new Date('2026-08-01T00:00:00.000Z');
  return {
    requestId: 'DS-RACE-001',
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
    payosTransferStatus: 'PROCESSING',
    payosTransferAttemptCount: 3,
    payosTransferLastError: null,
    transferIdempotencyKey: 'key-001',
    transactionHash: null,
    finalizeTransactionHash: null,
    createdAt: now,
    updatedAt: now,
    expiredAt: null,
    completedAt: null,
    ...overrides
  };
}

describe('processDisbursementTransferWebhook race guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'http://localhost:8545';
    process.env.MULTISIG_DISBURSEMENT_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.DONATION_ADMIN_PRIVATE_KEY = '0xabc';
    mockFinalizeDisbursement.mockResolvedValue({
      hash: '0xfinalize',
      wait: vi.fn().mockResolvedValue({ status: 1 })
    });
  });

  it('does not overwrite manual reject when SUCCESS webhook completes after reject', async () => {
    const approved = makeDisbursement();
    const rejected = makeDisbursement({ status: 'REJECTED', payosTransferStatus: 'FAILED' });
    mockFindDisbursementByRequestId
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(rejected);
    mockUpdateDisbursementByRequestIdWithCondition.mockResolvedValue(null);

    const result = await processDisbursementTransferWebhook(
      { requestId: 'DS-RACE-001', status: 'SUCCESS' },
      { skipChecksumVerify: true }
    );

    expect(result.status).toBe('REJECTED');
    expect(result.payosTransferStatus).toBe('FAILED');
    expect(mockUpdateDisbursementByRequestIdWithCondition).toHaveBeenCalledWith(
      'DS-RACE-001',
      expect.objectContaining({
        status: { $ne: 'REJECTED' },
        payosTransferStatus: { $ne: 'FAILED' }
      }),
      expect.objectContaining({ status: 'COMPLETED', payosTransferStatus: 'SUCCESS' })
    );
    expect(recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'finalize_disbursement',
      receipt: expect.objectContaining({ status: 1 })
    }));
    expect(mockRemovePendingJobsByRequestId).not.toHaveBeenCalled();
  });

  it('does not reopen manual review when finalize failure loses race to reject', async () => {
    const approved = makeDisbursement();
    const rejected = makeDisbursement({ status: 'REJECTED', payosTransferStatus: 'FAILED' });
    mockFinalizeDisbursement.mockRejectedValue(new Error('finalize failed'));
    mockFindDisbursementByRequestId
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(rejected);
    mockUpdateDisbursementByRequestIdWithCondition.mockResolvedValue(null);

    const result = await processDisbursementTransferWebhook(
      { requestId: 'DS-RACE-001', status: 'SUCCESS' },
      { skipChecksumVerify: true }
    );

    expect(result.status).toBe('REJECTED');
    expect(result.payosTransferStatus).toBe('FAILED');
    expect(mockUpdateDisbursementByRequestIdWithCondition).toHaveBeenCalledWith(
      'DS-RACE-001',
      expect.objectContaining({
        status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
        payosTransferStatus: { $nin: ['SUCCESS', 'FAILED'] }
      }),
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
    expect(mockOpenManualReviewQueueForDisbursement).not.toHaveBeenCalled();
  });

  it('does not finalize internal poll result after idempotency key rotation', async () => {
    const rotated = makeDisbursement({
      transferIdempotencyKey: 'key-002',
      payosTransferStatus: 'PROCESSING'
    });
    mockFindDisbursementByRequestId.mockResolvedValue(rotated);

    const result = await processDisbursementTransferWebhook(
      { requestId: 'DS-RACE-001', transferId: 'payos-001', status: 'SUCCESS' },
      {
        skipChecksumVerify: true,
        source: 'internal_poll',
        expectedTransferIdempotencyKey: 'key-001'
      }
    );

    expect(result.status).toBe('APPROVED');
    expect(result.payosTransferStatus).toBe('PROCESSING');
    expect(mockFinalizeDisbursement).not.toHaveBeenCalled();
    expect(mockUpdateDisbursementByRequestIdWithCondition).not.toHaveBeenCalled();
  });

  it('moves the webhook to manual review when finalize returns no receipt', async () => {
    const approved = makeDisbursement();
    const manualReview = makeDisbursement({ payosTransferStatus: 'MANUAL_REVIEW' });
    mockFinalizeDisbursement.mockResolvedValue({
      hash: '0xmissing-receipt',
      wait: vi.fn().mockResolvedValue(null)
    });
    mockFindDisbursementByRequestId.mockResolvedValueOnce(approved);
    mockUpdateDisbursementByRequestIdWithCondition.mockResolvedValue(manualReview);

    const result = await processDisbursementTransferWebhook(
      { requestId: 'DS-RACE-001', status: 'SUCCESS' },
      { skipChecksumVerify: true }
    );

    expect(result.payosTransferStatus).toBe('MANUAL_REVIEW');
    expect(mockUpdateDisbursementByRequestIdWithCondition).toHaveBeenCalledWith(
      'DS-RACE-001',
      expect.objectContaining({
        status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
        payosTransferStatus: { $nin: ['SUCCESS', 'FAILED'] }
      }),
      expect.objectContaining({ payosTransferStatus: 'MANUAL_REVIEW' })
    );
    expect(recordBlockchainTransaction).not.toHaveBeenCalled();
    expect(mockOpenManualReviewQueueForDisbursement).toHaveBeenCalledTimes(1);
  });

  it('records a reverted finalize receipt and moves the webhook to manual review', async () => {
    const approved = makeDisbursement();
    const manualReview = makeDisbursement({ payosTransferStatus: 'MANUAL_REVIEW' });
    const revertedReceipt = { status: 0, gasUsed: 21000n };
    mockFinalizeDisbursement.mockResolvedValue({
      hash: '0xreverted-finalize',
      wait: vi.fn().mockResolvedValue(revertedReceipt)
    });
    mockFindDisbursementByRequestId.mockResolvedValueOnce(approved);
    mockUpdateDisbursementByRequestIdWithCondition.mockResolvedValue(manualReview);

    const result = await processDisbursementTransferWebhook(
      { requestId: 'DS-RACE-001', status: 'SUCCESS' },
      { skipChecksumVerify: true }
    );

    expect(result.payosTransferStatus).toBe('MANUAL_REVIEW');
    expect(recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'finalize_disbursement',
      receipt: revertedReceipt
    }));
    expect(mockOpenManualReviewQueueForDisbursement).toHaveBeenCalledTimes(1);
  });
});
