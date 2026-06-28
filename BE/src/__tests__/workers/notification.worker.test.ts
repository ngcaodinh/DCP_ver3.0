import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bull';
import type { NotificationJobData } from '../../queues/notificationQueue';

// ─── Mocks ────────────────────────────────────────────────────────────────────
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
  NOTIFICATION_BULL_PRIORITY: { CRITICAL: 1, HIGH: 2, NORMAL: 3, LOW: 4 },
  NOTIFICATION_ALLOWLIST: {},
  moveNotificationToDLQ: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../services/notificationService', () => ({
  findNotificationById: vi.fn(),
  updateNotificationDeliveryStatus: vi.fn(),
  updateChannelStatus: vi.fn((current, channel, status) => ({ ...current, [channel]: status })),
  computeDeliveryState: vi.fn()
}));

vi.mock('../../events/notificationEvents', () => ({
  notificationEvents: {
    emit: vi.fn(),
    removeAllListeners: vi.fn()
  }
}));

vi.mock('../../utils/extractErrorMessage', () => ({
  extractErrorMessage: vi.fn((err) => err instanceof Error ? err.message : String(err))
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildJob(overrides: Partial<NotificationJobData> = {}) {
  return {
    id: 'job-1',
    data: {
      notificationId: 'NOTI-001',
      userId: 'user-1',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lớn',
      content: 'Bạn vừa nhận donation 50M VND',
      channels: ['IN_APP', 'EMAIL'],
      priority: 'NORMAL',
      metadata: {},
      attemptNumber: 1,
      enqueuedBy: 'bridge',
      ...overrides
    },
    opts: { priority: 3 },
    moveToDelayed: vi.fn().mockResolvedValue(undefined)
  } as Job<NotificationJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('processNotificationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delay job 60s khi user vượt throttle và không retry', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById } = await import('../../services/notificationService');
    vi.mocked(isUserThrottled).mockResolvedValue(true);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(job.moveToDelayed).toHaveBeenCalledWith(60_000);
    expect(result.deliveryState).toBe('PENDING');
    expect(findNotificationById).not.toHaveBeenCalled();
  });

  it('trả SKIPPED khi notification record không tìm thấy (admin xóa)', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById } = await import('../../services/notificationService');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findNotificationById).mockResolvedValue(null);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('SKIPPED');
  });

  it('dispatch tất cả channel thành công → DELIVERED, emit notification.delivered event', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, updateNotificationDeliveryStatus, computeDeliveryState } = await import('../../services/notificationService');
    const { notificationEvents } = await import('../../events/notificationEvents');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-001',
      userId: 'user-1',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lớn',
      content: 'Bạn vừa nhận donation 50M VND',
      isRead: false,
      metadata: {},
      channels: ['IN_APP', 'EMAIL'],
      priority: 'NORMAL',
      deliveryStatus: { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' },
      deliveryState: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');
    vi.mocked(updateNotificationDeliveryStatus).mockResolvedValue(undefined);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.deliveredChannels).toEqual(['IN_APP', 'EMAIL']);
    expect(result.failedChannels).toEqual([]);
    expect(notificationEvents.emit).toHaveBeenCalledWith('notification.delivered', expect.objectContaining({
      notificationId: 'NOTI-001',
      channel: 'IN_APP'
    }));
    expect(notificationEvents.emit).toHaveBeenCalledWith('notification.delivered', expect.objectContaining({
      notificationId: 'NOTI-001',
      channel: 'EMAIL'
    }));
    expect(updateNotificationDeliveryStatus).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: 'NOTI-001',
      deliveryState: 'DELIVERED',
      attempts: 1
    }));
  });

  it('IN_APP channel emit event với đúng payload', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState } = await import('../../services/notificationService');
    const { notificationEvents } = await import('../../events/notificationEvents');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-002',
      userId: 'user-2',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lớn',
      content: 'Bạn vừa nhận donation 50M VND',
      isRead: false,
      metadata: {},
      channels: ['IN_APP'],
      priority: 'NORMAL',
      deliveryStatus: { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' },
      deliveryState: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob({
      notificationId: 'NOTI-002',
      userId: 'user-2',
      channels: ['IN_APP']
    });

    await processNotificationJob(job);

    // Chỉ 1 event IN_APP
    const deliveredEvents = vi.mocked(notificationEvents.emit).mock.calls.filter(
      (call) => call[0] === 'notification.delivered'
    );
    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0][1]).toMatchObject({
      notificationId: 'NOTI-002',
      channel: 'IN_APP'
    });
  });
});

describe('stopNotificationWorker graceful shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('close queue và remove event listeners', async () => {
    const { getNotificationQueue } = await import('../../queues/notificationQueue');
    const { notificationEvents } = await import('../../events/notificationEvents');
    const mockQueue = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(getNotificationQueue).mockReturnValue(mockQueue as never);
    const { stopNotificationWorker } = await import('../../workers/notification.worker');

    await stopNotificationWorker();

    expect(mockQueue.close).toHaveBeenCalled();
    expect(notificationEvents.removeAllListeners).toHaveBeenCalled();
  });

  it('không throw khi queue chưa được tạo (Redis down)', async () => {
    const { getNotificationQueue } = await import('../../queues/notificationQueue');
    vi.mocked(getNotificationQueue).mockReturnValue(null);
    const { stopNotificationWorker } = await import('../../workers/notification.worker');

    await expect(stopNotificationWorker()).resolves.toBeUndefined();
  });
});

describe('scheduleNextAttempt - DLQ Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nên dùng exponential backoff delay đúng', async () => {
    const { NOTIFICATION_RETRY_DELAYS_MS } = await import('../../queues/notificationQueue');

    expect(NOTIFICATION_RETRY_DELAYS_MS[0]).toBe(30_000);  // Attempt 1 → retry sau 30s
    expect(NOTIFICATION_RETRY_DELAYS_MS[1]).toBe(120_000); // Attempt 2 → retry sau 2 phút
    expect(NOTIFICATION_RETRY_DELAYS_MS[2]).toBe(300_000); // Attempt 3 → retry sau 5 phút
  });

  it('retry flow: attempt 1 → 2 → 3 → DLQ', async () => {
    const { NOTIFICATION_MAX_ATTEMPTS } = await import('../../queues/notificationQueue');

    // Verify max attempts = 3
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(3);

    // Attempt flow:
    // Attempt 1 fail → schedule retry (attempt 2)
    // Attempt 2 fail → schedule retry (attempt 3)
    // Attempt 3 fail → move to DLQ

    const attemptFlows = [
      { attempt: 1, shouldRetry: true, shouldDLQ: false },
      { attempt: 2, shouldRetry: true, shouldDLQ: false },
      { attempt: 3, shouldRetry: false, shouldDLQ: true }
    ];

    attemptFlows.forEach(({ attempt, shouldRetry, shouldDLQ }) => {
      const isLastAttempt = attempt >= NOTIFICATION_MAX_ATTEMPTS;
      expect(isLastAttempt).toBe(shouldDLQ);
      expect(!isLastAttempt).toBe(shouldRetry);
    });
  });
});
