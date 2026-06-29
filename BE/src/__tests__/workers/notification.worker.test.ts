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
  computeDeliveryState: vi.fn(),
  getUnsubscribeTokenForUser: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  findUserNotificationContext: vi.fn()
}));

vi.mock('../../services/notificationDispatcher.service', () => ({
  dispatchNotification: vi.fn()
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

  it('delay job 60s khi user vuot throttle va khong retry', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    vi.mocked(isUserThrottled).mockResolvedValue(true);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(job.moveToDelayed).toHaveBeenCalledWith(60_000);
    expect(result.deliveryState).toBe('PENDING');
  });

  it('tra SKIPPED khi notification record khong tim thay (admin xoa)', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({ userId: 'user-1', userEmail: 'u@e.com', fcmDeviceToken: undefined, phoneNumber: undefined });
    vi.mocked(findNotificationById).mockResolvedValue(null);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('SKIPPED');
  });

  it('tra SKIPPED khi user bi xoa (khong co userContext)', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findUserNotificationContext } = await import('../../models/authModel');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue(null);
    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildJob();

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('SKIPPED');
    expect(result.deliveredChannels).toEqual([]);
    expect(result.failedChannels).toEqual([]);
  });

  it('dispatch IN_APP thanh cong — emit notification.delivered event', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { notificationEvents } = await import('../../events/notificationEvents');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({ userId: 'user-1', userEmail: 'u@e.com', fcmDeviceToken: undefined, phoneNumber: undefined });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue(null);
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-001',
      userId: 'user-1',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lon',
      content: 'Ban vua nhan donation 50M VND',
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
    const job = buildJob({ channels: ['IN_APP'] });

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.deliveredChannels).toEqual(['IN_APP']);
    expect(notificationEvents.emit).toHaveBeenCalledWith('notification.delivered', expect.objectContaining({
      notificationId: 'NOTI-001',
      channel: 'IN_APP'
    }));
  });

  it('IN_APP channel emit event voi dung payload', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { notificationEvents } = await import('../../events/notificationEvents');
    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({ userId: 'user-2', userEmail: 'u@e.com', fcmDeviceToken: undefined, phoneNumber: undefined });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue(null);
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-002',
      userId: 'user-2',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lon',
      content: 'Ban vua nhan donation 50M VND',
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

describe('E2 Dispatcher Integration - Worker wires dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildNotificationJob(overrides: Partial<NotificationJobData> = {}) {
    return {
      id: 'job-e2',
      data: {
        notificationId: 'NOTI-E2-001',
        userId: 'user-e2',
        notificationType: 'LARGE_DONATION',
        title: 'Donation lon',
        content: 'Ban vua nhan donation 50M VND',
        channels: ['EMAIL'],
        priority: 'NORMAL' as const,
        metadata: { donationAmountVnd: 50_000_000 },
        attemptNumber: 1,
        enqueuedBy: 'bridge',
        ...overrides
      },
      opts: { priority: 3 },
      moveToDelayed: vi.fn().mockResolvedValue(undefined)
    } as Job<NotificationJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
  }

  it('EMAIL channel goi dispatcher voi dung user context', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');
    const { notificationEvents } = await import('../../events/notificationEvents');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-e2',
      userEmail: 'user@example.com',
      fcmDeviceToken: 'fcm-token',
      phoneNumber: '+84912345678'
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue('unsub-tok-123');
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-E2-001',
      userId: 'user-e2',
      notificationType: 'LARGE_DONATION',
      title: 'Donation lon',
      content: 'Ban vua nhan donation 50M VND',
      isRead: false,
      metadata: { donationAmountVnd: 50_000_000 },
      channels: ['EMAIL'],
      priority: 'NORMAL',
      deliveryStatus: { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' },
      deliveryState: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(dispatchNotification).mockResolvedValue({
      notificationId: 'NOTI-E2-001',
      channelResults: [{ channel: 'EMAIL', result: { success: true, channel: 'EMAIL', providerMessageId: 'msg-123' } }],
      deliveryState: 'DELIVERED',
      totalAttempts: 1
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');

    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildNotificationJob({ channels: ['EMAIL'] });

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.deliveredChannels).toContain('EMAIL');
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'NOTI-E2-001',
        channels: ['EMAIL']
      }),
      expect.objectContaining({
        userId: 'user-e2',
        userEmail: 'user@example.com',
        fcmDeviceToken: 'fcm-token',
        phoneNumber: '+84912345678',
        unsubscribeToken: 'unsub-tok-123',
        donationAmountVnd: 50_000_000
      })
    );
    // EMAIL success — no notification.failed event
    const failedEvents = vi.mocked(notificationEvents.emit).mock.calls.filter(
      (call) => call[0] === 'notification.failed'
    );
    expect(failedEvents).toHaveLength(0);
  });

  it('PUSH channel goi dispatcher voi FCM token', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-push',
      userEmail: 'push@example.com',
      fcmDeviceToken: 'fcm-dev-token-xyz',
      phoneNumber: undefined
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue('tok-push');
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-PUSH-1',
      userId: 'user-push',
      notificationType: 'LARGE_DONATION',
      title: 'T',
      content: 'C',
      isRead: false,
      metadata: {},
      channels: ['PUSH'],
      priority: 'NORMAL',
      deliveryStatus: { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' },
      deliveryState: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(dispatchNotification).mockResolvedValue({
      notificationId: 'NOTI-PUSH-1',
      channelResults: [{ channel: 'PUSH', result: { success: true, channel: 'PUSH', providerMessageId: 'fcm-msg-1' } }],
      deliveryState: 'DELIVERED',
      totalAttempts: 1
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');

    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildNotificationJob({
      notificationId: 'NOTI-PUSH-1',
      userId: 'user-push',
      channels: ['PUSH']
    });

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ['PUSH'] }),
      expect.objectContaining({ fcmDeviceToken: 'fcm-dev-token-xyz' })
    );
  });

  it('SMS channel goi dispatcher voi phone number', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-sms',
      userEmail: 'sms@example.com',
      fcmDeviceToken: undefined,
      phoneNumber: '+84987654321'
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue(null);
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-SMS-1',
      userId: 'user-sms',
      notificationType: 'LARGE_DONATION',
      title: 'T',
      content: 'C',
      isRead: false,
      metadata: {},
      channels: ['SMS'],
      priority: 'NORMAL',
      deliveryStatus: { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' },
      deliveryState: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(dispatchNotification).mockResolvedValue({
      notificationId: 'NOTI-SMS-1',
      channelResults: [{ channel: 'SMS', result: { success: true, channel: 'SMS', providerMessageId: 'twilio-sid-1' } }],
      deliveryState: 'DELIVERED',
      totalAttempts: 1
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');

    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildNotificationJob({
      notificationId: 'NOTI-SMS-1',
      userId: 'user-sms',
      channels: ['SMS']
    });

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ['SMS'] }),
      expect.objectContaining({ phoneNumber: '+84987654321' })
    );
  });

  it('dispatcher tra loi that bai — channel danh dau FAILED, emit notification.failed event', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');
    const { notificationEvents } = await import('../../events/notificationEvents');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-fail',
      userEmail: 'fail@example.com',
      fcmDeviceToken: undefined,
      phoneNumber: undefined
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue('tok-fail');
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-FAIL-1',
      userId: 'user-fail',
      notificationType: 'LARGE_DONATION',
      title: 'T',
      content: 'C',
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
    // IN_APP succeeds, EMAIL fails → PARTIAL (not all fail, so no throw)
    vi.mocked(dispatchNotification).mockResolvedValue({
      notificationId: 'NOTI-FAIL-1',
      channelResults: [{ channel: 'EMAIL', result: { success: false, channel: 'EMAIL', errorMessage: 'SMTP timeout', retryable: true } }],
      deliveryState: 'PARTIAL',
      totalAttempts: 1
    });
    vi.mocked(computeDeliveryState).mockReturnValue('PARTIAL');

    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildNotificationJob({
      notificationId: 'NOTI-FAIL-1',
      userId: 'user-fail',
      channels: ['IN_APP', 'EMAIL']
    });

    const result = await processNotificationJob(job);

    // IN_APP delivered, EMAIL failed → PARTIAL
    expect(result.deliveredChannels).toContain('IN_APP');
    expect(result.failedChannels).toContain('EMAIL');
    expect(result.deliveryState).toBe('PARTIAL');
    // notification.failed duoc emit cho EMAIL
    const failedEvents = vi.mocked(notificationEvents.emit).mock.calls.filter(
      (call) => call[0] === 'notification.failed'
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0][1]).toMatchObject({
      channel: 'EMAIL',
      errorMessage: 'SMTP timeout'
    });
  });

  it('IN_APP channel van emit event (khong goi dispatcher)', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');
    const { notificationEvents } = await import('../../events/notificationEvents');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-inapp',
      userEmail: 'inapp@example.com',
      fcmDeviceToken: 'tok',
      phoneNumber: '+84900000000'
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue('tok-inapp');
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-INAPP-1',
      userId: 'user-inapp',
      notificationType: 'DONATION_RECEIVED',
      title: 'T',
      content: 'C',
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
    const job = buildNotificationJob({
      notificationId: 'NOTI-INAPP-1',
      userId: 'user-inapp',
      channels: ['IN_APP']
    });

    await processNotificationJob(job);

    // IN_APP khong goi dispatcher
    expect(dispatchNotification).not.toHaveBeenCalled();
    // Nhung van emit event
    expect(notificationEvents.emit).toHaveBeenCalledWith('notification.delivered', expect.objectContaining({
      notificationId: 'NOTI-INAPP-1',
      channel: 'IN_APP'
    }));
  });

  it('multi-channel dispatch: EMAIL + IN_APP cung luc', async () => {
    const { isUserThrottled } = await import('../../queues/notificationQueue');
    const { findNotificationById, computeDeliveryState, getUnsubscribeTokenForUser } = await import('../../services/notificationService');
    const { findUserNotificationContext } = await import('../../models/authModel');
    const { dispatchNotification } = await import('../../services/notificationDispatcher.service');
    const { notificationEvents } = await import('../../events/notificationEvents');

    vi.mocked(isUserThrottled).mockResolvedValue(false);
    vi.mocked(findUserNotificationContext).mockResolvedValue({
      userId: 'user-multi',
      userEmail: 'multi@example.com',
      fcmDeviceToken: undefined,
      phoneNumber: undefined
    });
    vi.mocked(getUnsubscribeTokenForUser).mockResolvedValue('tok-multi');
    vi.mocked(findNotificationById).mockResolvedValue({
      notificationId: 'NOTI-MULTI-1',
      userId: 'user-multi',
      notificationType: 'LARGE_DONATION',
      title: 'T',
      content: 'C',
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
    // dispatchNotification duoc goi cho EMAIL channel
    vi.mocked(dispatchNotification).mockResolvedValue({
      notificationId: 'NOTI-MULTI-1',
      channelResults: [{ channel: 'EMAIL', result: { success: true, channel: 'EMAIL', providerMessageId: 'msg-multi' } }],
      deliveryState: 'DELIVERED',
      totalAttempts: 1
    });
    vi.mocked(computeDeliveryState).mockReturnValue('DELIVERED');

    const { processNotificationJob } = await import('../../workers/notification.worker');
    const job = buildNotificationJob({
      notificationId: 'NOTI-MULTI-1',
      userId: 'user-multi',
      channels: ['IN_APP', 'EMAIL']
    });

    const result = await processNotificationJob(job);

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.deliveredChannels).toContain('IN_APP');
    expect(result.deliveredChannels).toContain('EMAIL');
    // IN_APP emit event
    expect(notificationEvents.emit).toHaveBeenCalledWith('notification.delivered', expect.objectContaining({
      notificationId: 'NOTI-MULTI-1',
      channel: 'IN_APP'
    }));
    // EMAIL goi dispatcher
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ['EMAIL'] }),
      expect.any(Object)
    );
  });
});
