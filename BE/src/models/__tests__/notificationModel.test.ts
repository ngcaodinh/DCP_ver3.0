import { describe, expect, it } from 'vitest';
import { NotificationModel } from '../notificationModel';

interface NotificationIndexFields {
  userId?: number;
  notificationType?: number;
  createdAt?: number;
}

type NotificationIndexEntry = [NotificationIndexFields, Record<string, unknown>];

describe('NotificationModel indexes', () => {
  it('defines compound index for user notification type sorted by newest first', () => {
    const indexes = NotificationModel.schema.indexes() as NotificationIndexEntry[];

    expect(indexes.some(([fields]) => (
      fields.userId === 1 && fields.notificationType === 1 && fields.createdAt === -1
    ))).toBe(true);
  });
});
