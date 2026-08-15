import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetRedisClientIfReady, mockWarn } = vi.hoisted(() => ({
  mockGetRedisClientIfReady: vi.fn<() => unknown>(() => null),
  mockWarn: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ warn: mockWarn, error: vi.fn(), info: vi.fn() }))
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: mockGetRedisClientIfReady
}));

import {
  __resetSubmissionThrottleState,
  MAX_FALLBACK_ENTRIES,
  SubmissionThrottleCapacityError,
  countAgainstLimit,
  releaseSubmissionSlot,
  claimOnce
} from '../../utils/submissionThrottle';

describe('submissionThrottle', () => {
  beforeEach(() => {
    __resetSubmissionThrottleState();
    mockGetRedisClientIfReady.mockReturnValue(null);
    mockWarn.mockClear();
  });

  it('uses in-memory fallback for an exclusive slot', async () => {
    expect(await claimOnce('slot-1', 90)).toBe(true);
    expect(await claimOnce('slot-1', 90)).toBe(false);

    await releaseSubmissionSlot('slot-1');
    expect(await claimOnce('slot-1', 90)).toBe(true);
  });

  it('enforces the daily quota in fallback mode', async () => {
    expect(await countAgainstLimit('ip-1', 2, 86400)).toBe(true);
    expect(await countAgainstLimit('ip-1', 2, 86400)).toBe(true);
    expect(await countAgainstLimit('ip-1', 2, 86400)).toBe(false);
  });

  it('throttles repeated Redis fallback warnings', async () => {
    vi.useFakeTimers();

    try {
      await claimOnce('slot-warning-1', 90);
      await countAgainstLimit('quota-warning-1', 2, 86400);

      expect(mockWarn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);
      await countAgainstLimit('quota-warning-2', 2, 86400);

      expect(mockWarn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets an expired fallback quota without scanning unrelated keys', async () => {
    vi.useFakeTimers();

    expect(await countAgainstLimit('ip-expiring', 1, 86400)).toBe(true);
    expect(await countAgainstLimit('ip-expiring', 1, 86400)).toBe(false);

    vi.advanceTimersByTime(86_400_001);

    expect(await countAgainstLimit('ip-expiring', 1, 86400)).toBe(true);
    vi.useRealTimers();
  });

  it('rejects with a capacity error when the bounded fallback counter store reaches capacity', async () => {
    for (let index = 0; index < MAX_FALLBACK_ENTRIES; index += 1) {
      expect(await countAgainstLimit(`ip-${index}`, 1, 86400)).toBe(true);
    }

    await expect(countAgainstLimit('ip-over-capacity', 1, 86400))
      .rejects.toBeInstanceOf(SubmissionThrottleCapacityError);
  });

  it('rejects with a capacity error when the bounded fallback slot store reaches capacity', async () => {
    for (let index = 0; index < MAX_FALLBACK_ENTRIES; index += 1) {
      expect(await claimOnce(`slot-${index}`, 90)).toBe(true);
    }

    await expect(claimOnce('slot-over-capacity', 90))
      .rejects.toBeInstanceOf(SubmissionThrottleCapacityError);
  });

  it('uses Redis SET NX EX and atomic counter when Redis is ready', async () => {
    const redisClient = {
      set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null),
      del: vi.fn().mockResolvedValue(1),
      multi: vi.fn(() => ({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([1, true])
      }))
    };
    mockGetRedisClientIfReady.mockReturnValue(redisClient);

    expect(await claimOnce('slot-redis', 90)).toBe(true);
    expect(await claimOnce('slot-redis', 90)).toBe(false);
    expect(redisClient.set).toHaveBeenCalledWith('slot-redis', '1', { NX: true, EX: 90 });
    await releaseSubmissionSlot('slot-redis');
    expect(redisClient.del).toHaveBeenCalledWith('slot-redis');
    expect(await countAgainstLimit('quota-redis', 500, 86400)).toBe(true);
  });
});
