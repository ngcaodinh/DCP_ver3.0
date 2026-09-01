import { describe, expect, it } from 'vitest';
import { NotificationModel } from '../../models/notificationModel';

describe('NotificationModel deliveryStatus', () => {
  it('chấp nhận trạng thái scalar theo từng channel như notification service ghi xuống', () => {
    const notification = new NotificationModel({
      notificationId: 'NOTI-MODEL-001',
      userId: 'user-1',
      notificationType: 'DONATION_RECEIVED',
      title: 'Donation received',
      content: 'Có donation mới.',
      metadata: {},
      channels: ['IN_APP', 'EMAIL'],
      priority: 'NORMAL',
      deliveryStatus: {
        IN_APP: 'PENDING',
        EMAIL: 'PENDING',
        PUSH: 'SKIPPED',
        SMS: 'PENDING'
      },
      deliveryState: 'PENDING',
      attempts: 0
    });

    expect(notification.validateSync()).toBeUndefined();
    expect(notification.deliveryStatus).toEqual({
      IN_APP: 'PENDING',
      EMAIL: 'PENDING',
      PUSH: 'SKIPPED',
      SMS: 'PENDING'
    });
  });

  it('từ chối trạng thái không thuộc enum deliveryStatus', () => {
    const notification = new NotificationModel({
      notificationId: 'NOTI-MODEL-002',
      userId: 'user-1',
      notificationType: 'DONATION_RECEIVED',
      title: 'Donation received',
      content: 'Có donation mới.',
      metadata: {},
      channels: ['IN_APP'],
      priority: 'NORMAL',
      deliveryStatus: {
        IN_APP: 'QUEUED',
        EMAIL: 'PENDING',
        PUSH: 'PENDING',
        SMS: 'PENDING'
      },
      deliveryState: 'PENDING',
      attempts: 0
    });

    expect(notification.validateSync()?.errors['deliveryStatus.IN_APP']).toBeDefined();
  });
});
