import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Test: sbtMintRecoveryScheduler
// =============================================================================
describe('sbtMintRecoveryScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    // Viết lại import để đảm bảo mocks được áp dụng trước
    vi.resetModules();
    vi.mock('../../services/sbtMintService', () => ({
      recoverStuckSbtMints: vi.fn().mockResolvedValue({ recovered: 0, enqueued: 0 })
    }));
    vi.mock('../../config/redis', () => ({
      getRedisClientIfReady: vi.fn(() => ({ options: { url: 'redis://localhost' } }))
    }));
    vi.mock('../../config/logger', () => ({
      getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    }));

    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    startSbtMintRecoveryScheduler();

    // Scheduler gọi setTimeout để lên lịch recovery cycle tiếp theo
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it('startSbtMintRecoveryScheduler không throw khi Redis chưa sẵn sàng', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.mock('../../services/sbtMintService', () => ({
      recoverStuckSbtMints: vi.fn().mockResolvedValue({ recovered: 0, enqueued: 0 })
    }));
    vi.mock('../../config/redis', () => ({
      getRedisClientIfReady: vi.fn(() => null)
    }));
    vi.mock('../../config/logger', () => ({
      getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    }));

    const { startSbtMintRecoveryScheduler } = await import('../../workers/sbtMintRecoveryScheduler');
    expect(() => startSbtMintRecoveryScheduler()).not.toThrow();
  });
});
