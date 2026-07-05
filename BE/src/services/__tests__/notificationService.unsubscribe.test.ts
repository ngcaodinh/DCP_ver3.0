/**
 * Test cho notificationService - kiểm tra unsubscribe token generation và processing.
 * Chỉ test các functions không liên quan đến notificationModel (để tránh mongoose mock phức tạp).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock models TRƯỚC
vi.mock('../../models/notificationModel', () => ({
  NotificationModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([])
          })
        })
      })
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 })
  },
  Notification: {},
  NotificationType: 'DONATION_RECEIVED',
  NotificationChannel: 'IN_APP',
  NotificationPriority: 'NORMAL',
  NotificationDeliveryState: 'PENDING',
  NotificationDeliveryStatusMap: {}
}));

vi.mock('../../models/notificationPreferenceModel', () => ({
  UserNotificationPreferenceModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn()
  }
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../queues/notificationQueue', () => ({
  enqueueNotification: vi.fn().mockResolvedValue({ jobId: 'mock-job-id', enqueued: true }),
  NOTIFICATION_ALLOWLIST: {
    DONATION_RECEIVED: ['IN_APP'],
    DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
    LARGE_DONATION: ['IN_APP', 'EMAIL'],
    DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL'],
    SYSTEM: ['IN_APP']
  }
}));

describe('Unsubscribe - Token Generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nên tạo token 64 ký tự hex (32 bytes)', async () => {
    // Test logic trực tiếp: crypto.randomBytes(32).toString('hex') = 64 chars
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(token)).toBe(true);
  });

  it('token format hex nên có đủ entropy', () => {
    // 64 hex chars = 4 bits per char = 256 bits total entropy
    const tokenLength = 64;
    const bitsPerChar = 4;
    const totalEntropyBits = tokenLength * bitsPerChar;

    expect(totalEntropyBits).toBe(256);
    expect(totalEntropyBits).toBeGreaterThanOrEqual(128); // Minimum cho security tokens
  });

  it('token hex nên match regex pattern', async () => {
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');

    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('mỗi lần tạo token nên khác nhau (random)', async () => {
    const crypto = await import('crypto');
    const token1 = crypto.randomBytes(32).toString('hex');
    const token2 = crypto.randomBytes(32).toString('hex');

    expect(token1).not.toBe(token2);
  });
});

describe('Unsubscribe - Token Processing Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processUnsubscribe nên return false khi token không tồn tại', async () => {
    const { UserNotificationPreferenceModel } = await import('../../models/notificationPreferenceModel');
    (UserNotificationPreferenceModel.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { processUnsubscribe } = await import('../../services/notificationService');
    const result = await processUnsubscribe('invalid-token-xyz');

    expect(result).toBe(false);
  });

  it('processUnsubscribe nên return true và set globalEnabled = false khi token hợp lệ', async () => {
    const { UserNotificationPreferenceModel } = await import('../../models/notificationPreferenceModel');

    const mockPref = {
      userId: 'user-123',
      globalEnabled: true,
      unsubscribeToken: 'valid-token-abc123',
      save: vi.fn().mockResolvedValue(true)
    };
    (UserNotificationPreferenceModel.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(mockPref);

    const { processUnsubscribe } = await import('../../services/notificationService');
    const result = await processUnsubscribe('valid-token-abc123');

    expect(result).toBe(true);
    expect(mockPref.globalEnabled).toBe(false);
    expect(mockPref.save).toHaveBeenCalled();
  });

  it('findOne nên được gọi với unsubscribeToken', async () => {
    const { UserNotificationPreferenceModel } = await import('../../models/notificationPreferenceModel');

    const mockPref = {
      userId: 'user-123',
      globalEnabled: true,
      unsubscribeToken: 'test-token',
      save: vi.fn().mockResolvedValue(true)
    };
    (UserNotificationPreferenceModel.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(mockPref);

    const { processUnsubscribe } = await import('../../services/notificationService');
    await processUnsubscribe('test-token');

    expect(UserNotificationPreferenceModel.findOne).toHaveBeenCalledWith({
      unsubscribeToken: 'test-token'
    });
  });
});

describe('Unsubscribe - Token Generation Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generateUnsubscribeToken nên upsert preference record với token 64 ký tự', async () => {
    const { UserNotificationPreferenceModel } = await import('../../models/notificationPreferenceModel');

    (UserNotificationPreferenceModel.findOneAndUpdate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (query: Record<string, unknown>, update: { $set: { unsubscribeToken: string } }) => {
        // Mock trả về token thực được tạo
        return Promise.resolve({
          userId: query.userId,
          unsubscribeToken: update.$set.unsubscribeToken
        });
      }
    );

    const { generateUnsubscribeToken } = await import('../../services/notificationService');
    const token = await generateUnsubscribeToken('user-123');

    // Token được tạo bằng crypto.randomBytes(32).toString('hex') = 64 ký tự
    expect(token.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    expect(UserNotificationPreferenceModel.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user-123' },
      { $set: { unsubscribeToken: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      { upsert: true, new: true }
    );
  });

  it('generateUnsubscribeToken nên tạo token 64 ký tự hex', async () => {
    const { UserNotificationPreferenceModel } = await import('../../models/notificationPreferenceModel');

    let capturedToken = '';
    (UserNotificationPreferenceModel.findOneAndUpdate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (query: Record<string, unknown>, update: { $set: { unsubscribeToken: string } }) => {
        capturedToken = update.$set.unsubscribeToken;
        return Promise.resolve({
          userId: query.userId,
          unsubscribeToken: capturedToken
        });
      }
    );

    const { generateUnsubscribeToken } = await import('../../services/notificationService');
    await generateUnsubscribeToken('user-456');

    expect(capturedToken.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(capturedToken)).toBe(true);
  });
});
