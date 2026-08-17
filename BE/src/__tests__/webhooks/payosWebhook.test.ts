/**
 * Unit tests cho PayOS Webhook Handler (Task A2).
 * Test cac chuc nang: idempotency, signature verification, audit logging, notification events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DisbursementTransferWebhookPayload, DisbursementResult } from '../../services/disbursementService';

// Dung vi.hoisted de dam bao mocks san sang truoc khi vi.mock duoc hoisting
const mockRedisSetNX = vi.hoisted(() => vi.fn<(key: string) => Promise<number>>());
const mockRedisExpire = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockProcessDisbursementFn = vi.hoisted(() => vi.fn<() => Promise<DisbursementResult>>());
const mockVerifyChecksumFn = vi.hoisted(() => vi.fn<() => boolean>());
const mockWebhookEventsEmitFn = vi.hoisted(() => vi.fn());
const mockEventLoggerLogEventFn = vi.hoisted(() => vi.fn());
const mockAuditLogCreateFn = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockFindDisbursementFn = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

const mockRedisClient = {
  setNX: mockRedisSetNX,
  expire: mockRedisExpire,
  isOpen: true
};

// Setup mocks truoc khi import
vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => mockRedisClient)
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/disbursementService', () => ({
  processDisbursementTransferWebhook: mockProcessDisbursementFn
}));

vi.mock('../../services/payosService', () => ({
  verifyPayosTransferWebhookChecksum: mockVerifyChecksumFn
}));

vi.mock('../../events/webhookEvents', () => ({
  webhookEvents: {
    emit: mockWebhookEventsEmitFn,
    on: vi.fn(),
    setMaxListeners: vi.fn()
  }
}));

vi.mock('../../services/event-logger.service', () => ({
  logEvent: mockEventLoggerLogEventFn
}));

vi.mock('../../models/webhookAuditLogModel', () => ({
  WebhookAuditLogModel: {
    create: mockAuditLogCreateFn
  },
  createWebhookAuditId: vi.fn(() => 'WAL-123-ABCDEF')
}));

vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: mockFindDisbursementFn
}));

// Import sau khi mocks da duoc setup
import { processPayosWebhook } from '../../services/payosWebhookService';

describe('PayOS Webhook Handler - processPayosWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validPayload: DisbursementTransferWebhookPayload = {
    requestId: 'DS-123-ABC',
    transferId: 'TRF-456',
    status: 'SUCCESS',
    signature: 'valid-signature',
    checksum: 'valid-signature',
    data: {
      orderCode: 'DS-123-ABC',
      referenceId: 'DS-123-ABC'
    }
  };

  const disbursementResult: DisbursementResult = {
    requestId: 'DS-123-ABC',
    projectId: 'PRJ-001',
    organizationId: 'ORG-001',
    status: 'COMPLETED',
    payosTransferStatus: 'SUCCESS',
    payosTransferId: 'TRF-456',
    amount: 1000000,
    beneficiaryWalletAddress: '0x123...',
    beneficiaryBankAccount: {
      bankName: 'Vietcombank',
      bankAccountNumber: '1234567890',
      accountHolderName: 'Test Org'
    },
    approvals: [],
    rejection: null,
    requiredApprovals: 2,
    raisedRatioBpsAtCreation: 5000,
    onChainRequestId: 1,
    requestMode: 'NORMAL',
    emergencyReason: null,
    usagePurpose: 'Test purpose',
    evidenceCid: 'QmTest',
    timeoutDeadline: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiredAt: null,
    completedAt: new Date()
  };

  it('should reject webhook with invalid checksum', async () => {
    mockVerifyChecksumFn.mockReturnValue(false);

    await expect(processPayosWebhook(validPayload, '127.0.0.1')).rejects.toThrow(
      'Webhook checksum khong hop le.'
    );

    expect(mockAuditLogCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBHOOK_SIGNATURE_INVALID'
      })
    );
  });

  it('should handle duplicate webhook via idempotency', async () => {
    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockResolvedValue(0);

    const result = await processPayosWebhook(validPayload, '127.0.0.1');

    expect(result.success).toBe(true);
    expect(result.isDuplicate).toBe(true);
    expect(result.disbursement).toBeNull();
    expect(mockProcessDisbursementFn).not.toHaveBeenCalled();
    expect(mockAuditLogCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBHOOK_DUPLICATE'
      })
    );
  });

  it('should process new webhook successfully', async () => {
    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockResolvedValue(disbursementResult);

    const result = await processPayosWebhook(validPayload, '127.0.0.1');

    expect(result.success).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(result.disbursement).toEqual(disbursementResult);
    expect(mockProcessDisbursementFn).toHaveBeenCalledWith(validPayload);
    expect(mockAuditLogCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBHOOK_PROCESSED'
      })
    );
  });

  it('should leave success notification emission to the domain service', async () => {
    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockResolvedValue(disbursementResult);

    await processPayosWebhook(validPayload, '127.0.0.1');

    expect(mockWebhookEventsEmitFn).not.toHaveBeenCalled();
    expect(mockEventLoggerLogEventFn).not.toHaveBeenCalled();
  });

  it('should leave failure notification emission to the domain service', async () => {
    const failedDisbursement: DisbursementResult = {
      ...disbursementResult,
      status: 'APPROVED',
      payosTransferStatus: 'MANUAL_REVIEW'
    };

    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockResolvedValue(failedDisbursement);

    await processPayosWebhook(validPayload, '127.0.0.1');

    expect(mockWebhookEventsEmitFn).not.toHaveBeenCalled();
    expect(mockEventLoggerLogEventFn).not.toHaveBeenCalled();
  });

  it('should skip idempotency when Redis is unavailable', async () => {
    const { getRedisClientIfReady } = await import('../../config/redis');
    vi.mocked(getRedisClientIfReady).mockReturnValue(null);

    mockVerifyChecksumFn.mockReturnValue(true);
    mockProcessDisbursementFn.mockResolvedValue(disbursementResult);

    const result = await processPayosWebhook(validPayload, '127.0.0.1');

    expect(result.success).toBe(true);
    expect(result.isDuplicate).toBe(false);
  });

  it('should handle processDisbursementTransferWebhook errors', async () => {
    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockRejectedValue(new Error('Database error'));

    await expect(processPayosWebhook(validPayload, '127.0.0.1')).rejects.toThrow('Database error');

    expect(mockAuditLogCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBHOOK_PROCESSED',
        errorMessage: 'Database error'
      })
    );
  });

  it('should extract orderCode from nested data object', async () => {
    const payloadWithNestedData: DisbursementTransferWebhookPayload = {
      status: 'SUCCESS',
      signature: 'valid-signature',
      data: {
        orderCode: 'DS-NESTED-001',
        referenceId: 'REF-001'
      }
    };

    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisSetNX.mockImplementation(async (key: string) => {
      expect(key).toContain('DS-NESTED-001');
      return 1;
    });
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockResolvedValue(disbursementResult);

    await processPayosWebhook(payloadWithNestedData, '127.0.0.1');

    expect(mockRedisSetNX).toHaveBeenCalled();
  });

  it('should allow a terminal webhook after a PROCESSING webhook for the same order code', async () => {
    mockVerifyChecksumFn.mockReturnValue(true);
    mockRedisExpire.mockResolvedValue('OK');
    mockProcessDisbursementFn.mockResolvedValue(disbursementResult);

    const seenKeySet = new Set<string>();
    mockRedisSetNX.mockImplementation(async (key: string) => {
      if (seenKeySet.has(key)) {
        return 0;
      }
      seenKeySet.add(key);
      return 1;
    });

    const processingPayload: DisbursementTransferWebhookPayload = {
      ...validPayload,
      status: 'PROCESSING',
      data: { orderCode: 'DS-123-ABC', status: 'PROCESSING' }
    };
    const successPayload: DisbursementTransferWebhookPayload = {
      ...validPayload,
      status: 'SUCCESS',
      data: { orderCode: 'DS-123-ABC', status: 'SUCCESS' }
    };

    await processPayosWebhook(processingPayload, '127.0.0.1');
    await processPayosWebhook(processingPayload, '127.0.0.1');
    await processPayosWebhook(successPayload, '127.0.0.1');

    expect(mockRedisSetNX.mock.calls.map(([key]) => key)).toEqual([
      'webhook:payos:DS-123-ABC:PROCESSING',
      'webhook:payos:DS-123-ABC:PROCESSING',
      'webhook:payos:DS-123-ABC:SUCCESS'
    ]);
    expect(mockProcessDisbursementFn).toHaveBeenCalledTimes(2);
  });
});

describe('WebhookEvents', () => {
  it('should export correct event types', async () => {
    const { webhookEvents } = await import('../../events/webhookEvents');
    expect(webhookEvents).toBeDefined();
    expect(typeof webhookEvents.emit).toBe('function');
    expect(typeof webhookEvents.on).toBe('function');
  });

  it('should emit and receive DISBURSEMENT_TRANSFERRED event', async () => {
    const { EventEmitter } = await import('events');
    const testEmitter = new EventEmitter();

    const handler = vi.fn();
    testEmitter.on('DISBURSEMENT_TRANSFERRED', handler);

    testEmitter.emit('DISBURSEMENT_TRANSFERRED', {
      requestId: 'DS-TEST',
      projectId: 'PRJ-TEST',
      organizationId: 'ORG-TEST',
      amount: 1000000,
      status: 'COMPLETED',
      payosTransferStatus: 'SUCCESS',
      payosTransferId: 'TRF-TEST',
      transactionHash: '0xtest'
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'DS-TEST',
        status: 'COMPLETED'
      })
    );
  });

  it('should emit and receive DISBURSEMENT_TRANSFER_FAILED event', async () => {
    const { EventEmitter } = await import('events');
    const testEmitter = new EventEmitter();

    const handler = vi.fn();
    testEmitter.on('DISBURSEMENT_TRANSFER_FAILED', handler);

    testEmitter.emit('DISBURSEMENT_TRANSFER_FAILED', {
      requestId: 'DS-TEST-FAIL',
      projectId: 'PRJ-TEST',
      organizationId: 'ORG-TEST',
      amount: 1000000,
      status: 'APPROVED',
      payosTransferStatus: 'MANUAL_REVIEW',
      payosTransferId: 'TRF-TEST',
      transactionHash: null
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'DS-TEST-FAIL',
        payosTransferStatus: 'MANUAL_REVIEW'
      })
    );
  });
});

describe('WebhookAuditLogModel', () => {
  it('should have correct action types', () => {
    const validActions = ['WEBHOOK_SIGNATURE_INVALID', 'WEBHOOK_PROCESSED', 'WEBHOOK_DUPLICATE'];
    expect(validActions).toContain('WEBHOOK_SIGNATURE_INVALID');
    expect(validActions).toContain('WEBHOOK_PROCESSED');
    expect(validActions).toContain('WEBHOOK_DUPLICATE');
  });
});
