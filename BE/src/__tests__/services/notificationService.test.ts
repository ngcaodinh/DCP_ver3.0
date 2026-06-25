import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeDeliveryState,
  updateChannelStatus
} from '../../services/notificationService';

// Mocks
vi.mock('../../models/notificationModel', () => ({
  NotificationModel: {
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
    findOne: vi.fn()
  }
}));

vi.mock('../../models/notificationPreferenceModel', () => ({
  UserNotificationPreferenceModel: {
    findOne: vi.fn()
  }
}));

vi.mock('../../queues/notificationQueue', () => ({
  enqueueNotification: vi.fn(),
  NOTIFICATION_ALLOWLIST: {
    DONATION_RECEIVED: ['IN_APP'],
    DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
    LARGE_DONATION: ['IN_APP', 'EMAIL'],
    DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL'],
    SYSTEM: ['IN_APP']
  }
}));

// Tests for computeDeliveryState
describe('computeDeliveryState', () => {
  it('tra SKIPPED khi requestedChannels rong', () => {
    const status = {
      IN_APP: 'PENDING' as const,
      EMAIL: 'PENDING' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, [])).toBe('SKIPPED');
  });

  it('tra DELIVERED khi tat ca channel deu SENT', () => {
    const status = {
      IN_APP: 'SENT' as const,
      EMAIL: 'SENT' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, ['IN_APP', 'EMAIL'])).toBe('DELIVERED');
  });

  it('tra SKIPPED khi tat ca channel deu SKIPPED', () => {
    const status = {
      IN_APP: 'SKIPPED' as const,
      EMAIL: 'SKIPPED' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, ['IN_APP', 'EMAIL'])).toBe('SKIPPED');
  });

  it('tra PARTIAL khi co 1 SENT va 1 FAILED', () => {
    const status = {
      IN_APP: 'SENT' as const,
      EMAIL: 'FAILED' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, ['IN_APP', 'EMAIL'])).toBe('PARTIAL');
  });

  it('tra PARTIAL khi co 1 SENT va 1 SKIPPED', () => {
    const status = {
      IN_APP: 'SENT' as const,
      EMAIL: 'SKIPPED' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, ['IN_APP', 'EMAIL'])).toBe('PARTIAL');
  });

  it('tra FAILED khi tat ca channel fail hoac pending', () => {
    const status = {
      IN_APP: 'FAILED' as const,
      EMAIL: 'PENDING' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    expect(computeDeliveryState(status, ['IN_APP', 'EMAIL'])).toBe('FAILED');
  });
});

// Tests for updateChannelStatus
describe('updateChannelStatus', () => {
  it('cap nhat 1 channel va giu nguyen cac channel khac', () => {
    const initial = {
      IN_APP: 'PENDING' as const,
      EMAIL: 'PENDING' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    const result = updateChannelStatus(initial, 'IN_APP', 'SENT');
    expect(result.IN_APP).toBe('SENT');
    expect(result.EMAIL).toBe('PENDING');
    expect(result.PUSH).toBe('PENDING');
    expect(result.SMS).toBe('PENDING');
  });

  it('tra ve object moi (immutable)', () => {
    const initial = {
      IN_APP: 'PENDING' as const,
      EMAIL: 'PENDING' as const,
      PUSH: 'PENDING' as const,
      SMS: 'PENDING' as const
    };
    const result = updateChannelStatus(initial, 'EMAIL', 'FAILED');
    expect(result).not.toBe(initial);
    expect(initial.EMAIL).toBe('PENDING');
  });
});