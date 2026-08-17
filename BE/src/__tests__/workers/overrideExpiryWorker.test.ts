import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPendingOverrideRequestsExpiredBefore: vi.fn(),
  expireOverrideRequest: vi.fn(),
  recordAdminAuditLog: vi.fn(),
  logOverrideExpired: vi.fn(),
  createUserNotification: vi.fn()
}));

vi.mock('../../models/oracleOverrideRequestModel', () => ({
  findPendingOverrideRequestsExpiredBefore: mocks.findPendingOverrideRequestsExpiredBefore,
  expireOverrideRequest: mocks.expireOverrideRequest
}));
vi.mock('../../services/audit-log.service', () => ({
  recordAdminAuditLog: mocks.recordAdminAuditLog
}));
vi.mock('../../services/multisigOverrideLog.service', () => ({
  logOverrideExpired: mocks.logOverrideExpired
}));
vi.mock('../../services/notificationService', () => ({
  createUserNotification: mocks.createUserNotification
}));
vi.mock('../../config/requestContext', () => ({
  runWithWorkerContext: vi.fn((_name: string, operation: () => Promise<void>) => operation())
}));
vi.mock('../../utils/mongoTransaction', () => ({
  runMongoTransaction: vi.fn(async (operation: (session?: undefined) => Promise<unknown>) => operation(undefined))
}));
vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

import {
  startOverrideExpiryWorker,
  stopOverrideExpiryWorker
} from '../../workers/overrideExpiryWorker';

describe('overrideExpiryWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.findPendingOverrideRequestsExpiredBefore.mockResolvedValue([
      {
        overrideRequestId: 'override-timeout-1',
        projectId: 'project-1',
        organizationId: 'organization-1',
        commissionerSnapshot: [{ userId: 'commissioner-1', role: 'admin' }]
      }
    ]);
    mocks.expireOverrideRequest.mockResolvedValue({
      overrideRequestId: 'override-timeout-1',
      projectId: 'project-1',
      organizationId: 'organization-1',
      commissionerSnapshot: [{ userId: 'commissioner-1', role: 'admin' }],
      expiredAt: new Date()
    });
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);
    mocks.logOverrideExpired.mockResolvedValue(undefined);
    mocks.createUserNotification.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopOverrideExpiryWorker();
    vi.useRealTimers();
  });

  it('ghi multisig override log cho timeout expiry với actor SYSTEM', async () => {
    startOverrideExpiryWorker();
    await vi.waitFor(() => expect(mocks.logOverrideExpired).toHaveBeenCalledWith(
      expect.objectContaining({ overrideRequestId: 'override-timeout-1' }),
      'SYSTEM',
      'TIMEOUT'
    ));
  });
});
