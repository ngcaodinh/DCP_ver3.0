import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteUserNotification,
  getUnreadCount,
  getUserPreferences,
  markNotificationAsRead,
  updateUserPreferences
} from '../../services/notificationService';

const mocks = vi.hoisted(() => ({
  deleteOneExec: vi.fn(),
  deleteOne: vi.fn(),
  countDocuments: vi.fn(),
  countDocumentsExec: vi.fn(),
  findOneAndUpdateLeanExec: vi.fn(),
  preferenceFindOneLeanExec: vi.fn(),
  preferenceCreate: vi.fn(),
  preferenceFindOneAndUpdate: vi.fn(),
  preferenceFindOneAndUpdateLeanExec: vi.fn()
}));

vi.mock('../../models/notificationModel', () => ({
  NotificationModel: {
    findOneAndUpdate: () => ({ lean: () => ({ exec: mocks.findOneAndUpdateLeanExec }) }),
    countDocuments: (...args: unknown[]) => {
      mocks.countDocuments(...args);
      return { exec: mocks.countDocumentsExec };
    },
    deleteOne: (...args: unknown[]) => {
      mocks.deleteOne(...args);
      return { exec: mocks.deleteOneExec };
    }
  }
}));

vi.mock('../../models/notificationPreferenceModel', () => ({
  UserNotificationPreferenceModel: {
    findOne: () => ({ lean: () => ({ exec: mocks.preferenceFindOneLeanExec }) }),
    create: mocks.preferenceCreate,
    findOneAndUpdate: (...args: unknown[]) => {
      mocks.preferenceFindOneAndUpdate(...args);
      return { lean: () => ({ exec: mocks.preferenceFindOneAndUpdateLeanExec }) };
    }
  }
}));

vi.mock('../../queues/notificationQueue', () => ({
  enqueueNotification: vi.fn(),
  NOTIFICATION_ALLOWLIST: {
    DONATION_RECEIVED: ['IN_APP'],
    DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
    LARGE_DONATION: ['IN_APP', 'EMAIL'],
    DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL'],
    OVERRIDE_APPROVED: ['IN_APP', 'EMAIL'],
    SBT_MINT_FAILED: ['IN_APP', 'EMAIL'],
    SYSTEM: ['IN_APP']
  }
}));

describe('notificationService preference and notification operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('xóa notification chỉ khi thuộc user hiện tại', async () => {
    mocks.deleteOneExec.mockResolvedValue({ deletedCount: 1 });

    await expect(deleteUserNotification('NOTI-123', 'user-1')).resolves.toBe(true);
    expect(mocks.deleteOne).toHaveBeenCalledWith({ notificationId: 'NOTI-123', userId: 'user-1' });
  });

  it('trả false khi notification không tồn tại', async () => {
    mocks.deleteOneExec.mockResolvedValue({ deletedCount: 0 });

    await expect(deleteUserNotification('NOTI-999', 'user-1')).resolves.toBe(false);
  });

  it('đếm unread notification', async () => {
    mocks.countDocumentsExec.mockResolvedValue(7);

    await expect(getUnreadCount('user-1')).resolves.toBe(7);
    expect(mocks.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      notificationType: { $in: expect.arrayContaining(['DONATION_RECEIVED', 'DISBURSEMENT_SIGNED']) },
      $or: [{ channels: 'IN_APP' }, { channels: { $exists: false } }],
      isRead: false
    }));
  });

  it('returns zero when the user has no unread notifications', async () => {
    mocks.countDocumentsExec.mockResolvedValue(0);

    await expect(getUnreadCount('new-user')).resolves.toBe(0);
  });

  it('mark-read trả notification đã cập nhật và giữ IDOR filter', async () => {
    mocks.findOneAndUpdateLeanExec.mockResolvedValue({ notificationId: 'NOTI-123', isRead: true });

    await expect(markNotificationAsRead('NOTI-123', 'user-1')).resolves.toMatchObject({ isRead: true });
    expect(mocks.findOneAndUpdateLeanExec).toHaveBeenCalledTimes(1);
  });

  it('returns null when mark-read cannot find the notification', async () => {
    mocks.findOneAndUpdateLeanExec.mockResolvedValue(null);

    await expect(markNotificationAsRead('NOTI-MISSING', 'user-1')).resolves.toBeNull();
  });

  it('lấy preference hiện tại và version', async () => {
    mocks.preferenceFindOneLeanExec.mockResolvedValue({
      userId: 'user-1',
      globalEnabled: true,
      version: 4,
      preferences: { LARGE_DONATION: { IN_APP: true } }
    });

    await expect(getUserPreferences('user-1')).resolves.toEqual({
      globalEnabled: true,
      version: 4,
      preferences: { LARGE_DONATION: { IN_APP: true } }
    });
  });

  it('tạo preference mặc định với version 0 khi chưa có record', async () => {
    mocks.preferenceFindOneLeanExec.mockResolvedValue(null);
    mocks.preferenceCreate.mockResolvedValue({
      userId: 'user-new',
      globalEnabled: true,
      version: 0,
      preferences: {}
    });

    await expect(getUserPreferences('user-new')).resolves.toEqual({ globalEnabled: true, version: 0, preferences: {} });
    expect(mocks.preferenceCreate).toHaveBeenCalledWith({
      userId: 'user-new',
      preferences: {},
      globalEnabled: true,
      version: 0
    });
  });

  it('migrate record cũ chưa có version trước khi FE cập nhật', async () => {
    mocks.preferenceFindOneLeanExec.mockResolvedValue({ userId: 'legacy-user', globalEnabled: true, preferences: {} });
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({ userId: 'legacy-user', globalEnabled: true, preferences: {}, version: 0 });

    await expect(getUserPreferences('legacy-user')).resolves.toMatchObject({ version: 0 });
    expect(mocks.preferenceFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'legacy-user' },
      { $set: { version: 0 } },
      { returnDocument: 'after' }
    );
  });

  it('từ chối notification type có key không an toàn', async () => {
    await expect(updateUserPreferences('user-1', {
      preferences: { 'invalid.type': { IN_APP: true } }
    })).rejects.toMatchObject({ code: 'INVALID_TYPE' });
  });

  it('rejects prototype keys in preference maps', async () => {
    await expect(updateUserPreferences('user-1', {
      preferences: { CONSTRUCTOR: { IN_APP: true } }
    })).rejects.toMatchObject({ code: 'INVALID_TYPE' });
  });

  it('từ chối channel có key không an toàn', async () => {
    await expect(updateUserPreferences('user-1', {
      preferences: { LARGE_DONATION: { fax: true } }
    })).rejects.toMatchObject({ code: 'INVALID_CHANNEL' });
  });

  it('từ chối channel có giá trị không phải boolean', async () => {
    await expect(updateUserPreferences('user-1', {
      preferences: { LARGE_DONATION: { CUSTOM: 'yes' as unknown as boolean } }
    })).rejects.toMatchObject({ code: 'INVALID_CHANNEL' });
  });

  it('cho phép và bảo toàn notification type/channel future an toàn', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({
      globalEnabled: true,
      preferences: { FUTURE_NOTIFICATION_TYPE: { CUSTOM: true } },
      version: 1
    });

    const result = await updateUserPreferences('user-1', {
      preferences: { FUTURE_NOTIFICATION_TYPE: { CUSTOM: true } },
      version: 0
    });

    expect(result.preferences.FUTURE_NOTIFICATION_TYPE?.CUSTOM).toBe(true);
    expect(result.version).toBe(1);
    expect(mocks.preferenceFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user-1', version: 0 },
      { $set: { preferences: { FUTURE_NOTIFICATION_TYPE: { CUSTOM: true } } }, $inc: { version: 1 } },
      { upsert: false, returnDocument: 'after', runValidators: true }
    );
  });

  it('trả conflict khi version stale để ngăn lost update', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValueOnce(null);

    await expect(updateUserPreferences('user-1', {
      preferences: { LARGE_DONATION: { EMAIL: false } },
      version: 0
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects invalid versions as validation errors', async () => {
    await expect(updateUserPreferences('user-1', {
      preferences: {},
      version: -1
    })).rejects.toMatchObject({ code: 'INVALID_VERSION' });
  });

  it('cập nhật globalEnabled theo legacy payload không có version', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({
      globalEnabled: false,
      preferences: {},
      version: 1
    });

    await expect(updateUserPreferences('user-1', { globalEnabled: false })).resolves.toEqual({
      globalEnabled: false,
      preferences: {},
      version: 1
    });
  });

  it('updates a valid full preference map without a version', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({
      globalEnabled: true,
      preferences: { LARGE_DONATION: { EMAIL: false } },
      version: 1
    });

    await expect(updateUserPreferences('user-1', {
      preferences: { LARGE_DONATION: { EMAIL: false } }
    })).resolves.toMatchObject({
      preferences: { LARGE_DONATION: { EMAIL: false } },
      version: 1
    });
  });
});
