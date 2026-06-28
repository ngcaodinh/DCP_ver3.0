import { describe, it, expect, vi } from 'vitest';

const NOTIFICATION_BULL_PRIORITY = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4
};

const NOTIFICATION_ALLOWLIST: Record<string, string[]> = {
  DONATION_RECEIVED: ['IN_APP'],
  DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
  LARGE_DONATION: ['IN_APP', 'EMAIL'],
  DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL'],
  SYSTEM: ['IN_APP']
};

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn()
}));

vi.mock('../../queues/notificationQueue', () => ({
  getNotificationQueue: vi.fn(),
  enqueueNotification: vi.fn(),
  isUserThrottled: vi.fn(),
  NOTIFICATION_MAX_ATTEMPTS: 3,
  NOTIFICATION_RETRY_DELAYS_MS: [30_000, 120_000, 300_000],
  NOTIFICATION_THROTTLE_DELAY_MS: 60_000,
  NOTIFICATION_BULL_PRIORITY: {
    CRITICAL: 1,
    HIGH: 2,
    NORMAL: 3,
    LOW: 4
  },
  NOTIFICATION_ALLOWLIST: {
    DONATION_RECEIVED: ['IN_APP'],
    DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
    LARGE_DONATION: ['IN_APP', 'EMAIL'],
    DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL'],
    SYSTEM: ['IN_APP']
  }
}));

describe('NOTIFICATION_BULL_PRIORITY', () => {
  it('CRITICAL < HIGH < NORMAL < LOW (Bull: thap hon chay truoc)', () => {
    expect(NOTIFICATION_BULL_PRIORITY.CRITICAL).toBeLessThan(NOTIFICATION_BULL_PRIORITY.HIGH);
    expect(NOTIFICATION_BULL_PRIORITY.HIGH).toBeLessThan(NOTIFICATION_BULL_PRIORITY.NORMAL);
    expect(NOTIFICATION_BULL_PRIORITY.NORMAL).toBeLessThan(NOTIFICATION_BULL_PRIORITY.LOW);
  });
});

describe('NOTIFICATION_ALLOWLIST', () => {
  it('LARGE_DONATION cho phep IN_APP va EMAIL', () => {
    expect(NOTIFICATION_ALLOWLIST.LARGE_DONATION).toContain('IN_APP');
    expect(NOTIFICATION_ALLOWLIST.LARGE_DONATION).toContain('EMAIL');
  });

  it('DONATION_RECEIVED chi cho phep IN_APP (khong spam email)', () => {
    expect(NOTIFICATION_ALLOWLIST.DONATION_RECEIVED).toEqual(['IN_APP']);
  });

  it('SYSTEM notification chi cho phep IN_APP', () => {
    expect(NOTIFICATION_ALLOWLIST.SYSTEM).toEqual(['IN_APP']);
  });

  it('DISBURSEMENT_SIGNED cho phep IN_APP va EMAIL', () => {
    expect(NOTIFICATION_ALLOWLIST.DISBURSEMENT_SIGNED).toContain('IN_APP');
    expect(NOTIFICATION_ALLOWLIST.DISBURSEMENT_SIGNED).toContain('EMAIL');
  });
});
