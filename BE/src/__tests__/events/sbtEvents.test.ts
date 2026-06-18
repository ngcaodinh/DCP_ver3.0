import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Test: sbtEvents - EventEmitter patterns
// ============================================================

describe('sbtEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export sbtEvents as an EventEmitter-like object', async () => {
    const { sbtEvents } = await import('../../events/sbtEvents');
    expect(sbtEvents).toBeDefined();
    expect(typeof sbtEvents.on).toBe('function');
    expect(typeof sbtEvents.emit).toBe('function');
    expect(typeof sbtEvents.removeListener).toBe('function');
    expect(typeof sbtEvents.removeAllListeners).toBe('function');
  });

  it('should emit sbt.minted event and listener receives correct payload', async () => {
    const { sbtEvents } = await import('../../events/sbtEvents');

    const receivedPayloads: Array<{
      sbtId: string;
      mintRequestId: string;
      onChainTokenId: number;
      transactionHash: string;
      blockNumber: number;
      mintedAt: Date;
    }> = [];

    const listener = (payload: {
      sbtId: string;
      mintRequestId: string;
      onChainTokenId: number;
      transactionHash: string;
      blockNumber: number;
      mintedAt: Date;
    }) => {
      receivedPayloads.push(payload);
    };

    sbtEvents.on('sbt.minted', listener);

    sbtEvents.emit('sbt.minted', {
      sbtId: 'SBT-123',
      mintRequestId: 'SBT-MINT-456',
      onChainTokenId: 789,
      transactionHash: '0xtxhash123',
      blockNumber: 12345678,
      mintedAt: new Date('2024-01-01T00:00:00Z'),
    });

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].sbtId).toBe('SBT-123');
    expect(receivedPayloads[0].mintRequestId).toBe('SBT-MINT-456');
    expect(receivedPayloads[0].onChainTokenId).toBe(789);
    expect(receivedPayloads[0].transactionHash).toBe('0xtxhash123');
    expect(receivedPayloads[0].blockNumber).toBe(12345678);
    expect(receivedPayloads[0].mintedAt).toBeInstanceOf(Date);

    sbtEvents.removeListener('sbt.minted', listener);
  });

  it('should emit sbt.mint-failed event and listener receives payload', async () => {
    const { sbtEvents } = await import('../../events/sbtEvents');

    const receivedPayloads: Array<{
      sbtId: string;
      mintRequestId: string;
      projectId: string;
      organizationId: string;
      attemptNumber: number;
      errorMessage: string;
      failedAt: Date;
    }> = [];

    const listener = (payload: {
      sbtId: string;
      mintRequestId: string;
      projectId: string;
      organizationId: string;
      attemptNumber: number;
      errorMessage: string;
      failedAt: Date;
    }) => {
      receivedPayloads.push(payload);
    };

    sbtEvents.on('sbt.mint-failed', listener);

    sbtEvents.emit('sbt.mint-failed', {
      sbtId: 'SBT-999',
      mintRequestId: 'SBT-MINT-888',
      projectId: 'proj-fail',
      organizationId: 'org-fail',
      attemptNumber: 3,
      errorMessage: 'RPC timeout',
      failedAt: new Date('2024-02-02T00:00:00Z'),
    });

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].sbtId).toBe('SBT-999');
    expect(receivedPayloads[0].errorMessage).toBe('RPC timeout');
    expect(receivedPayloads[0].attemptNumber).toBe(3);
    expect(receivedPayloads[0].failedAt).toBeInstanceOf(Date);

    sbtEvents.removeListener('sbt.mint-failed', listener);
  });

  it('should emit sbt.mint-dlq event and listener receives payload', async () => {
    const { sbtEvents } = await import('../../events/sbtEvents');

    const receivedPayloads: Array<{
      sbtId: string;
      mintRequestId: string;
      projectId: string;
      organizationId: string;
      beneficiaryAddress: string;
      attemptNumber: number;
      lastErrorMessage: string;
      dlqAt: Date;
    }> = [];

    const listener = (payload: {
      sbtId: string;
      mintRequestId: string;
      projectId: string;
      organizationId: string;
      beneficiaryAddress: string;
      attemptNumber: number;
      lastErrorMessage: string;
      dlqAt: Date;
    }) => {
      receivedPayloads.push(payload);
    };

    sbtEvents.on('sbt.mint-dlq', listener);

    sbtEvents.emit('sbt.mint-dlq', {
      sbtId: 'SBT-DLQ-001',
      mintRequestId: 'SBT-MINT-DLQ-001',
      projectId: 'proj-dlq',
      organizationId: 'org-dlq',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      attemptNumber: 6,
      lastErrorMessage: 'All retries exhausted',
      dlqAt: new Date('2024-03-03T00:00:00Z'),
    });

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].sbtId).toBe('SBT-DLQ-001');
    expect(receivedPayloads[0].lastErrorMessage).toBe('All retries exhausted');
    expect(receivedPayloads[0].attemptNumber).toBe(6);
    expect(receivedPayloads[0].dlqAt).toBeInstanceOf(Date);

    sbtEvents.removeListener('sbt.mint-dlq', listener);
  });

  it('should support multiple listeners for the same event', async () => {
    const { sbtEvents } = await import('../../events/sbtEvents');

    const listener1Calls: number[] = [];
    const listener2Calls: number[] = [];

    const listener1 = () => listener1Calls.push(1);
    const listener2 = () => listener2Calls.push(2);

    sbtEvents.on('sbt.minted', listener1);
    sbtEvents.on('sbt.minted', listener2);

    sbtEvents.emit('sbt.minted', {
      sbtId: 'SBT-MULTI',
      mintRequestId: 'SBT-MINT-MULTI',
      onChainTokenId: 100,
      transactionHash: '0xtxhash',
      blockNumber: 1,
      imageCid: 'QmMulti',
      tokenUri: 'ipfs://QmMulti',
      organizationId: 'org-multi',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      mintedAt: new Date(),
    });

    expect(listener1Calls).toHaveLength(1);
    expect(listener2Calls).toHaveLength(1);

    sbtEvents.removeAllListeners('sbt.minted');
  });
});
