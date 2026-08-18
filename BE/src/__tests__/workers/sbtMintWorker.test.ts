import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Dùng vi.hoisted để mock emit function nằm trong cùng scope với factory
const mockOracleEmit = vi.hoisted(() => vi.fn());
const reportTerminalErrorMock = vi.hoisted(() => vi.fn());
const triggerSbtMintFromOracleMock = vi.hoisted(() => vi.fn().mockResolvedValue({ enqueued: true, duplicate: false }));

// Mock oracleEvents before importing the worker
vi.mock('../../events/oracleEvents', () => ({
  oracleEvents: {
    on: vi.fn((_event: string, handler: (...args: unknown[]) => void) => {
      mockOracleEmit.mockImplementation(handler as (...args: unknown[]) => void);
    }),
    removeAllListeners: vi.fn()
  }
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()
  })
}));

vi.mock('../../utils/sentryReporter', () => ({
  reportTerminalError: reportTerminalErrorMock
}));

vi.mock('../../queues/sbtMintQueue', () => ({
  getSbtMintQueue: vi.fn(() => ({
    process: vi.fn(),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  })),
  SBT_MINT_RETRY_DELAYS_MS: [300000, 900000, 3600000, 3600000, 14400000, 86400000],
  SBT_MINT_MAX_ATTEMPTS: 7,
  enqueueSbtMint: vi.fn().mockResolvedValue({ jobId: 'job-123', enqueued: true }),
  removePendingSbtMintJobsByRequestId: vi.fn().mockResolvedValue(0)
}));

vi.mock('../../services/sbtMintService', () => ({
  executeSbtMint: vi.fn(),
  handleSbtMintFailure: vi.fn(),
  extractErrorMessage: vi.fn((e) => e instanceof Error ? e.message : String(e)),
  SbtSubmissionPersistenceError: class SbtSubmissionPersistenceError extends Error {}
}));

vi.mock('../../services/sbt-trigger.service', () => ({
  triggerSbtMintFromOracle: triggerSbtMintFromOracleMock
}));

vi.mock('../../events/sbtEvents', () => ({
  sbtEvents: { emit: vi.fn() }
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  createBlockedImpactSbtMetadata: vi.fn()
}));

import { Job } from 'bull';
import { oracleEvents } from '../../events/oracleEvents';
import { executeSbtMint, handleSbtMintFailure } from '../../services/sbtMintService';

// =============================================================================
// Test: processSbtMintJob
// =============================================================================
describe('sbtMintWorker - processSbtMintJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gọi executeSbtMint và trả về result khi thành công', async () => {
    const { processSbtMintJob } = await import('../../workers/sbtMintWorker');

    const mockResult = {
      onChainTokenId: 42,
      transactionHash: '0xtxhash',
      blockNumber: 12345,
      status: 'CONFIRMED' as const
    };
    (executeSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const mockJob = {
      id: 'job-1',
      data: {
        mintRequestId: 'SBT-MINT-123',
        sbtId: 'SBT-123',
        attemptNumber: 1,
        enqueuedBy: 'oracle_event'
      }
    } as unknown as Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>;

    const result = await processSbtMintJob(mockJob);

    expect(executeSbtMint).toHaveBeenCalledWith('SBT-MINT-123', 1);
    expect(result.status).toBe('CONFIRMED');
    expect(result.onChainTokenId).toBe(42);
    expect(result.attemptNumber).toBe(1);
  });

  it('throw error khi failure movedToDlq=true (ngăn Bull retry)', async () => {
    const { processSbtMintJob } = await import('../../workers/sbtMintWorker');

    (executeSbtMint as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('contract revert'));
    (handleSbtMintFailure as ReturnType<typeof vi.fn>).mockResolvedValue({
      willRetry: false,
      movedToDlq: true,
      nextDelayMs: null
    });

    const mockJob = {
      id: 'job-2',
      data: {
        mintRequestId: 'SBT-MINT-dlq',
        sbtId: 'SBT-dlq',
        attemptNumber: 6,
        enqueuedBy: 'oracle_event'
      }
    } as unknown as Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>;

    let thrownError: unknown;
    try {
      await processSbtMintJob(mockJob);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError).toMatchObject({
      message: 'SBT mint moved to DLQ after 6 attempts (1 initial attempt plus retries): contract revert'
    });
    expect(reportTerminalErrorMock).toHaveBeenCalledWith(
      expect.any(String),
      thrownError,
      expect.objectContaining({ errorSource: 'job-dlq' })
    );
  });

  it('trả về FAILED status khi failure willRetry=true (Bull không retry lại)', async () => {
    const { processSbtMintJob } = await import('../../workers/sbtMintWorker');

    (executeSbtMint as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC timeout'));
    (handleSbtMintFailure as ReturnType<typeof vi.fn>).mockResolvedValue({
      willRetry: true,
      movedToDlq: false,
      nextDelayMs: 300000
    });

    const mockJob = {
      id: 'job-3',
      data: {
        mintRequestId: 'SBT-MINT-retry',
        sbtId: 'SBT-retry',
        attemptNumber: 2,
        enqueuedBy: 'oracle_event'
      }
    } as unknown as Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>;

    const result = await processSbtMintJob(mockJob);

    expect(result.status).toBe('FAILED');
    expect(result.attemptNumber).toBe(2);
    expect(reportTerminalErrorMock).not.toHaveBeenCalled();
  });

  it('re-throws original error khi failure không retry và không DLQ', async () => {
    const { processSbtMintJob } = await import('../../workers/sbtMintWorker');

    (executeSbtMint as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('record deleted'));
    (handleSbtMintFailure as ReturnType<typeof vi.fn>).mockResolvedValue({
      willRetry: false,
      movedToDlq: false,
      nextDelayMs: null
    });

    const mockJob = {
      id: 'job-4',
      data: {
        mintRequestId: 'SBT-MINT-edge',
        sbtId: 'SBT-edge',
        attemptNumber: 1,
        enqueuedBy: 'oracle_event'
      }
    } as unknown as Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>;

    await expect(processSbtMintJob(mockJob))
      .rejects.toThrow('record deleted');
  });
});

// =============================================================================
// Test: attachOracleEventListener (via oracle.verified emit)
// =============================================================================
describe('sbtMintWorker - attachOracleEventListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { stopSbtMintWorker } = await import('../../workers/sbtMintWorker');
    await stopSbtMintWorker();
  });

  it('bỏ qua payload có field dư hoặc thiếu verificationId', async () => {
    const { startSbtMintWorker } = await import('../../workers/sbtMintWorker');
    startSbtMintWorker();

    // Lấy handler đã đăng ký
    const onHandler = (oracleEvents.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(onHandler).toBeDefined();

    // Payload cũ có field client-controlled nên bị reject ở boundary.
    await onHandler({
      projectId: 'proj-1'
    });

    expect(triggerSbtMintFromOracleMock).not.toHaveBeenCalled();
  });

  it('dispatch chỉ verificationId và không tạo BLOCKED placeholder', async () => {
    const { startSbtMintWorker } = await import('../../workers/sbtMintWorker');
    startSbtMintWorker();

    const onHandler = (oracleEvents.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(onHandler).toBeDefined();

    // Event nhẹ; worker/service tự lookup verification + authoritative fields.
    await onHandler({
      verificationId: 'ver-valid'
    });

    expect(triggerSbtMintFromOracleMock).toHaveBeenCalledWith({ verificationId: 'ver-valid' });
  });
});
