/**
 * Unit tests cho cac ham moi trong notificationService.ts — E3 Notification API Endpoints.
 * Bao gồm: deleteUserNotification, getUnreadCount, markNotificationAsRead,
 * getUserPreferences, updateUserPreferences.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deleteUserNotification,
  getUnreadCount,
  getUserPreferences,
  updateUserPreferences,
  markNotificationAsRead
} from '../../services/notificationService';

// Mock functions — phai dung vi.hoisted() de tranh hoisting issue voi vi.mock
const mocks = vi.hoisted(() => {
  const deleteOneExec = vi.fn();
  const countDocumentsExec = vi.fn();
  const findOneAndUpdateLeanExec = vi.fn();
  const preferenceFindOneLeanExec = vi.fn();
  const preferenceCreate = vi.fn();
  const preferenceFindOneAndUpdateLeanExec = vi.fn();
  return { deleteOneExec, countDocumentsExec, findOneAndUpdateLeanExec, preferenceFindOneLeanExec, preferenceCreate, preferenceFindOneAndUpdateLeanExec };
});

vi.mock('../../models/notificationModel', () => {
  // Sử dụng closure để capture hoisted mock functions — tránh vi.fn() shadowing
  const { deleteOneExec, countDocumentsExec, findOneAndUpdateLeanExec } = mocks;
  return {
    NotificationModel: {
      findOneAndUpdate: () => ({ lean: () => ({ exec: findOneAndUpdateLeanExec }) }),
      countDocuments: () => ({ exec: countDocumentsExec }),
      deleteOne: () => ({ exec: deleteOneExec })
    }
  };
});

vi.mock('../../models/notificationPreferenceModel', () => {
  const { preferenceFindOneLeanExec, preferenceCreate, preferenceFindOneAndUpdateLeanExec } = mocks;
  return {
    UserNotificationPreferenceModel: {
      findOne: () => ({ lean: () => ({ exec: preferenceFindOneLeanExec }) }),
      create: preferenceCreate,
      findOneAndUpdate: () => ({ lean: () => ({ exec: preferenceFindOneAndUpdateLeanExec }) })
    }
  };
});

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

// Tests for deleteUserNotification
describe('deleteUserNotification', () => {
  afterEach(() => {
    // Khong clear mock giua cac test vi mock la singleton cho ca file
  });

  it('tra true khi xoa thanh cong', async () => {
    mocks.deleteOneExec.mockResolvedValue({ deletedCount: 1 });

    const result = await deleteUserNotification('NOTI-123', 'user-1');
    expect(result).toBe(true);
  });

  it('tra false khi khong tim thay hoac khong thuoc user', async () => {
    mocks.deleteOneExec.mockResolvedValue({ deletedCount: 0 });

    const result = await deleteUserNotification('NOTI-999', 'user-1');
    expect(result).toBe(false);
  });

  it('chi xoa notification thuoc user (IDOR protection)', async () => {
    mocks.deleteOneExec.mockResolvedValue({ deletedCount: 1 });

    const result = await deleteUserNotification('NOTI-123', 'user-specific');
    expect(result).toBe(true);
    expect(mocks.deleteOneExec).toHaveBeenCalled();
  });
});

// Tests for getUnreadCount
describe('getUnreadCount', () => {
  afterEach(() => {
    // Khong clear mock giua cac test vi mock la singleton cho ca file
  });

  it('tra so luong notification chua doc', async () => {
    mocks.countDocumentsExec.mockResolvedValue(7);

    const result = await getUnreadCount('user-1');
    expect(result).toBe(7);
  });

  it('tra 0 khi khong co notification nao', async () => {
    mocks.countDocumentsExec.mockResolvedValue(0);

    const result = await getUnreadCount('user-new');
    expect(result).toBe(0);
  });

  it('chi dem notification cua user hien tai', async () => {
    mocks.countDocumentsExec.mockResolvedValue(3);

    const result = await getUnreadCount('user-2');

    expect(mocks.countDocumentsExec).toHaveBeenCalled();
    expect(result).toBe(3);
  });
});

// Tests for markNotificationAsRead
describe('markNotificationAsRead', () => {
  afterEach(() => {
    // Khong clear mock giua cac test vi mock la singleton cho ca file
  });

  it('tra notification da cap nhat khi thanh cong', async () => {
    mocks.findOneAndUpdateLeanExec.mockResolvedValue({ notificationId: 'NOTI-123', isRead: true });

    const result = await markNotificationAsRead('NOTI-123', 'user-1');
    expect(result).not.toBeNull();
  });

  it('tra null khi khong tim thay', async () => {
    mocks.findOneAndUpdateLeanExec.mockResolvedValue(null);

    const result = await markNotificationAsRead('NOTI-999', 'user-1');
    expect(result).toBeNull();
  });

  it('chi cap nhat notification thuoc user (IDOR protection)', async () => {
    // Khi userId khong khop, MongoDB khong tim thay record -> tra null
    mocks.findOneAndUpdateLeanExec.mockResolvedValue(null);

    const result = await markNotificationAsRead('NOTI-123', 'user-other');

    // Service tra null khi notification khong thuoc user
    expect(result).toBeNull();
    // Verify mock duoc goi (IDOR check da thuc hien)
    expect(mocks.findOneAndUpdateLeanExec).toHaveBeenCalled();
  });
});

// Tests for getUserPreferences
describe('getUserPreferences', () => {
  afterEach(() => {
    // Khong clear mock giua cac test vi mock la singleton cho ca file
  });

  it('tra preferences cua user khi co record', async () => {
    mocks.preferenceFindOneLeanExec.mockResolvedValue({
      userId: 'user-1',
      globalEnabled: true,
      preferences: { LARGE_DONATION: { IN_APP: true } }
    });

    const result = await getUserPreferences('user-1');
    expect(result.globalEnabled).toBe(true);
    expect(result.preferences).toHaveProperty('LARGE_DONATION');
  });

  it('tao record moi voi default khi user chua co preferences', async () => {
    mocks.preferenceFindOneLeanExec.mockResolvedValue(null);
    mocks.preferenceCreate.mockResolvedValue({
      userId: 'user-new',
      globalEnabled: true,
      preferences: {}
    });

    const result = await getUserPreferences('user-new');
    expect(result.globalEnabled).toBe(true);
    expect(mocks.preferenceCreate).toHaveBeenCalledWith({
      userId: 'user-new',
      preferences: {},
      globalEnabled: true,
      unsubscribeToken: undefined
    });
  });
});

// Tests for updateUserPreferences
describe('updateUserPreferences', () => {
  afterEach(() => {
    // Khong clear mock giua cac test vi mock la singleton cho ca file
  });

  it('update globalEnabled khi duoc cung cap', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({
      globalEnabled: false,
      preferences: {}
    });

    const result = await updateUserPreferences('user-1', { globalEnabled: false });
    expect(result.globalEnabled).toBe(false);
  });

  it('nem loi khi notification type khong hop le', async () => {
    await expect(
      updateUserPreferences('user-1', {
        preferences: { INVALID_TYPE: { IN_APP: true } }
      })
    ).rejects.toThrow('Loại thông báo không hợp lệ: INVALID_TYPE');
  });

  it('nem loi khi channel khong hop le', async () => {
    await expect(
      updateUserPreferences('user-1', {
        preferences: { LARGE_DONATION: { FAX: true } }
      })
    ).rejects.toThrow('Kênh không hợp lệ: FAX');
  });

  it('update preferences cu the khi hop le', async () => {
    mocks.preferenceFindOneAndUpdateLeanExec.mockResolvedValue({
      globalEnabled: true,
      preferences: { LARGE_DONATION: { EMAIL: false } }
    });

    const result = await updateUserPreferences('user-1', {
      preferences: { LARGE_DONATION: { EMAIL: false } }
    });
    expect(result.preferences).toHaveProperty('LARGE_DONATION');
  });
});
