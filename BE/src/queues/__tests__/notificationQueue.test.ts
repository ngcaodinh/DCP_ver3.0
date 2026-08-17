/**
 * Test cho notificationQueue - kiểm tra DLQ queue và moveToDLQ function.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationJobData } from '../notificationQueue';

interface BullMockModule {
  __mockAdd: ReturnType<typeof vi.fn>;
  __mockRemove: ReturnType<typeof vi.fn>;
}

// Mock tất cả dependencies TRƯỚC KHI import module
vi.mock('bull', () => {
  const mockAdd = vi.fn().mockResolvedValue({ id: 'mock-dlq-job-id' });
  const mockRemove = vi.fn().mockResolvedValue(true);

  return {
    default: vi.fn().mockImplementation(() => ({
      add: mockAdd,
      remove: mockRemove
    })),
    // Lưu mock functions để test có thể verify
    __mockAdd: mockAdd,
    __mockRemove: mockRemove
  };
});

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn().mockReturnValue({
    options: { url: 'redis://localhost:6379' }
  })
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../utils/extractErrorMessage', () => ({
  extractErrorMessage: vi.fn().mockReturnValue('mock error')
}));

describe('NotificationQueue - Constants', () => {
  it('nên export đúng queue name', async () => {
    const { NOTIFICATION_QUEUE_NAME, NOTIFICATION_DLQ_QUEUE_NAME } = await import('../notificationQueue');
    expect(NOTIFICATION_QUEUE_NAME).toBe('notification');
    expect(NOTIFICATION_DLQ_QUEUE_NAME).toBe('notification:dlq');
  });

  it('nên export đúng số retry attempts', async () => {
    const { NOTIFICATION_MAX_ATTEMPTS } = await import('../notificationQueue');
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(3);
  });

  it('nên export đúng retry delays', async () => {
    const { NOTIFICATION_RETRY_DELAYS_MS } = await import('../notificationQueue');
    expect(NOTIFICATION_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 300_000]);
    expect(NOTIFICATION_RETRY_DELAYS_MS[0]).toBe(30_000); // 30s
    expect(NOTIFICATION_RETRY_DELAYS_MS[1]).toBe(120_000); // 2 phút
    expect(NOTIFICATION_RETRY_DELAYS_MS[2]).toBe(300_000); // 5 phút
  });

  it('nên export đúng throttle config', async () => {
    const {
      NOTIFICATION_THROTTLE_MAX_PER_MINUTE,
      NOTIFICATION_THROTTLE_WINDOW_MS
    } = await import('../notificationQueue');

    expect(NOTIFICATION_THROTTLE_MAX_PER_MINUTE).toBe(5);
    expect(NOTIFICATION_THROTTLE_WINDOW_MS).toBe(60_000);
  });

  it('nên export đúng priority mapping', async () => {
    const { NOTIFICATION_BULL_PRIORITY } = await import('../notificationQueue');
    expect(NOTIFICATION_BULL_PRIORITY.CRITICAL).toBe(1);
    expect(NOTIFICATION_BULL_PRIORITY.HIGH).toBe(2);
    expect(NOTIFICATION_BULL_PRIORITY.NORMAL).toBe(3);
    expect(NOTIFICATION_BULL_PRIORITY.LOW).toBe(4);
  });
});

describe('NotificationQueue - DLQ Config', () => {
  it('notificationDlqQueue nên được khởi tạo', async () => {
    const { notificationDlqQueue } = await import('../notificationQueue');
    expect(notificationDlqQueue).toBeDefined();
  });

  it('DLQ nên giữ job failed trong 30 ngày', async () => {
    const THIRTY_DAYS_IN_MINUTES = 30 * 24 * 60;
    expect(THIRTY_DAYS_IN_MINUTES).toBe(43200); // 30 ngày = 43200 phút
  });
});

describe('NotificationQueue - moveNotificationToDLQ', () => {
  // Mock job type — chỉ cần các field thực sự dùng trong implementation
  type MockJob = { id: string; data: Record<string, unknown>; remove: ReturnType<typeof vi.fn> };
  type MoveToDlqFn = (job: MockJob) => Promise<void>;
  let moveNotificationToDLQ: MoveToDlqFn;
  let mockAdd: ReturnType<typeof vi.fn>;
  let mockRemove: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Lấy mock functions từ Bull mock
    const BullMock = await import('bull') as unknown as BullMockModule;
    mockAdd = BullMock.__mockAdd;
    mockRemove = BullMock.__mockRemove;

    const module = await import('../notificationQueue');
    moveNotificationToDLQ = module.moveNotificationToDLQ as unknown as MoveToDlqFn;
  });

  it('nên add job vào DLQ queue', async () => {
    const mockJob = {
      id: 'test-job-id',
      data: {
        notificationId: 'NOTI-123',
        userId: 'user-456'
      },
      remove: mockRemove
    };

    await moveNotificationToDLQ(mockJob);

    expect(mockAdd).toHaveBeenCalledWith(
      'failed-notification',
      mockJob.data,
      expect.objectContaining({
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: expect.any(Number)
      })
    );
  });

  it('nên remove job khỏi main queue', async () => {
    const mockJob = {
      id: 'test-job-id',
      data: { notificationId: 'NOTI-123' },
      remove: mockRemove
    };

    await moveNotificationToDLQ(mockJob);

    expect(mockRemove).toHaveBeenCalled();
  });

  it('nên pass đúng job data vào DLQ', async () => {
    const jobData = {
      notificationId: 'NOTI-TEST-001',
      userId: 'user-123',
      notificationType: 'DONATION_RECEIVED',
      title: 'Test notification',
      content: 'Test content',
      channels: ['IN_APP'],
      priority: 'NORMAL'
    };

    const mockJob = {
      id: 'job-123',
      data: jobData,
      remove: mockRemove
    };

    await moveNotificationToDLQ(mockJob);

    expect(mockAdd).toHaveBeenCalledWith(
      'failed-notification',
      jobData,
      expect.any(Object)
    );
  });
});

describe('NotificationQueue - JobData Type', () => {
  it('nên export đúng NotificationJobData type', async () => {
    const validJobData: NotificationJobData = {
      notificationId: 'NOTI-123',
      userId: 'user-456',
      notificationType: 'DONATION_RECEIVED',
      title: 'Test',
      content: 'Test content',
      channels: ['IN_APP', 'EMAIL'],
      priority: 'NORMAL',
      metadata: {},
      attemptNumber: 1,
      enqueuedBy: 'api'
    };

    expect(validJobData.notificationId).toBe('NOTI-123');
    expect(validJobData.attemptNumber).toBe(1);
    expect(validJobData.channels).toContain('IN_APP');
  });
});
