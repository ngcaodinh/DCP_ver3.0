import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Test: sbtMintRecoveryScheduler
// =============================================================================

// Dùng vi.hoisted để tạo mock functions có thể reference trong vi.mock factories
const { mockRecoverStuckSbtMints, mockReplayPendingOracleSbtMints, mockGetRedisClient, mockLogger } = vi.hoisted(() => ({
  mockRecoverStuckSbtMints: vi.fn().mockResolvedValue({ recovered: 0, enqueued: 0 }),
  mockReplayPendingOracleSbtMints: vi.fn().mockResolvedValue(0),
  mockGetRedisClient: vi.fn(() => ({ options: { url: 'redis://localhost' } })),
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

vi.mock('../../services/sbtMintService', () => ({
  recoverStuckSbtMints: mockRecoverStuckSbtMints
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: mockGetRedisClient
}));

vi.mock('../../config/logger', () => ({
  getLogger: mockLogger
}));

vi.mock('../../workers/sbtMintWorker', () => ({
  replayPendingOracleSbtMints: mockReplayPendingOracleSbtMints
}));

describe('sbtMintRecoveryScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecoverStuckSbtMints.mockResolvedValue({ recovered: 0, enqueued: 0 });
    mockGetRedisClient.mockReturnValue({ options: { url: 'redis://localhost' } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('export startSbtMintRecoveryScheduler là function', async () => {
    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    expect(typeof startSbtMintRecoveryScheduler).toBe('function');
  });

  it('gọi setTimeout khi khởi động scheduler để lên lịch recovery', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    startSbtMintRecoveryScheduler();

    // Scheduler gọi setTimeout để lên lịch recovery cycle tiếp theo
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it('startSbtMintRecoveryScheduler không throw khi Redis chưa sẵn sàng', async () => {
    vi.useFakeTimers();
    // cast sang unknown trước để tránh TS strict type mismatch
    mockGetRedisClient.mockReturnValue(null as unknown as ReturnType<typeof mockGetRedisClient>);

    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    expect(() => startSbtMintRecoveryScheduler()).not.toThrow();
  });

  it('scheduler gọi recoverStuckSbtMints khi interval trigger', async () => {
    vi.useFakeTimers();

    // Stub setTimeout để ngăn recursive loop — chỉ chạy callback khi explicit gọi
    const origSetTimeout = globalThis.setTimeout.bind(globalThis);
    let capturedCallback: ((...args: unknown[]) => Promise<void>) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = ((cb: (...args: unknown[]) => Promise<void>) => {
      capturedCallback = cb;
      return 0;
    }) as typeof origSetTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).clearTimeout = (() => {}) as typeof globalThis.clearTimeout;

    // Stub Date.now để tránh idempotency guard blocking (now - lastRunTimestamp check)
    const OrigDate = Date;
    let mockTime = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = class extends OrigDate {
      static override now() { return mockTime; }
    };

    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    startSbtMintRecoveryScheduler();

    // Verify recoverStuckSbtMints chưa được gọi trước khi interval
    expect(mockRecoverStuckSbtMints).not.toHaveBeenCalled();

    // Trigger callback — đại diện cho khi interval fire
    mockTime = 900_001; // > MIN_RUN_INTERVAL_MS để pass idempotency guard
    if (capturedCallback) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (capturedCallback as any)();
    }

    // Verify recoverStuckSbtMints được gọi sau khi interval trigger
    expect(mockRecoverStuckSbtMints).toHaveBeenCalledWith(15); // STUCK_THRESHOLD_MINUTES = 15

    // Restore globals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = origSetTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = OrigDate;
  });
});
