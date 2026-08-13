import { describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAdminAuditLog: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  countDocuments: vi.fn()
}));

vi.mock('../../models/adminAuditLogModel', () => ({
  AdminAuditLogModel: {
    findOne: mocks.findOne,
    find: mocks.find,
    countDocuments: mocks.countDocuments
  },
  createAdminAuditLog: mocks.createAdminAuditLog
}));

import {
  buildAuditLogQuery,
  listAdminAuditLogs,
  recordAdminAuditLog,
  sanitizeAuditContext
} from '../../services/audit-log.service';

function buildQueryChain<T>(value: T) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(value)
  };
  return chain;
}

describe('audit-log.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminAuditLog.mockResolvedValue(undefined);
  });

  it('ghi canonical record, lọc context và chỉ escalation khi amount > 10M', async () => {
    await recordAdminAuditLog({
      actionId: 'action-10m',
      actorType: 'ADMIN',
      adminId: 'admin-1',
      adminRole: 'admin',
      actionType: 'MANUAL_APPROVE',
      targetId: 'request-1',
      targetType: 'DISBURSEMENT_REQUEST',
      reason: 'Đã kiểm tra hồ sơ',
      ipAddress: '10.0.0.1',
      userAgent: 'test-agent',
      context: {
        amountVnd: 10_000_000,
        requestId: 'request-1',
        bankAccountNumber: '4111111111111111',
        rawBody: { accessToken: 'secret' }
      }
    });

    const exactThresholdRecord = mocks.createAdminAuditLog.mock.calls[0][0];
    expect(exactThresholdRecord.requiresEscalation).toBe(false);
    expect(exactThresholdRecord.escalationPolicy).toBeNull();
    expect(exactThresholdRecord.context).toEqual({ amountVnd: 10_000_000, requestId: 'request-1' });
    expect(exactThresholdRecord.context.bankAccountNumber).toBeUndefined();

    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: 'admin-1',
      adminRole: 'admin',
      actionType: 'MANUAL_APPROVE',
      targetId: 'request-2',
      targetType: 'DISBURSEMENT_REQUEST',
      context: { amountVnd: 10_000_001 }
    });

    const overThresholdRecord = mocks.createAdminAuditLog.mock.calls[1][0];
    expect(overThresholdRecord.requiresEscalation).toBe(true);
    expect(overThresholdRecord.escalationPolicy).toBe('MANUAL_APPROVAL_GT_10M_VND');
  });

  it('ép system actor không có admin/IP/user-agent và giữ actionId replay idempotent', async () => {
    mocks.createAdminAuditLog.mockRejectedValueOnce({ code: 11000 });
    mocks.findOne.mockReturnValue(buildQueryChain({ actionId: 'system-expiry' }));

    await expect(recordAdminAuditLog({
      actionId: 'system-expiry',
      actorType: 'SYSTEM',
      adminId: null,
      adminRole: null,
      actionType: 'OVERRIDE_EXPIRED',
      targetId: 'override-1',
      targetType: 'OVERRIDE_REQUEST',
      ipAddress: '198.51.100.10',
      userAgent: 'spoofed'
    })).resolves.toEqual(expect.objectContaining({
      actionId: 'system-expiry',
      adminId: null,
      ipAddress: null,
      userAgent: null
    }));

    const savedRecord = mocks.createAdminAuditLog.mock.calls[0][0];
    expect(savedRecord.adminUserId).toBe('system');
    expect(savedRecord.ipAddress).toBeNull();
    expect(savedRecord.userAgent).toBeNull();
    expect(mocks.findOne).toHaveBeenCalledWith({ actionId: 'system-expiry' });
  });

  it('từ chối target không khớp action và sanitize context theo allowlist', async () => {
    await expect(recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: 'admin-1',
      adminRole: 'admin',
      actionType: 'FEEDBACK_FLAG',
      targetId: 'request-1',
      targetType: 'DISBURSEMENT_REQUEST'
    })).rejects.toMatchObject({ statusCode: 400, errorCode: 'VALIDATION_ERROR' });

    expect(sanitizeAuditContext('SBT_MINT_RERUN_REQUESTED', {
      mintRequestId: 'mint-1',
      jobId: 'job-1',
      walletAddress: '0xsecret'
    })).toEqual({ mintRequestId: 'mint-1', jobId: 'job-1' });

    expect(sanitizeAuditContext('MANUAL_REJECT', {
      previousError: { message: 'provider failed', access_token: 'secret' }
    })).toEqual({ previousError: { message: 'provider failed' } });
  });

  it('list server-side filter, sort, projection và pagination trước database', async () => {
    mocks.find.mockReturnValue(buildQueryChain([{
      actionId: 'action-1',
      actionType: 'MANUAL_REJECT',
      adminId: 'admin-1',
      adminRole: 'admin',
      targetId: 'request-1',
      targetType: 'DISBURSEMENT_REQUEST',
      reason: 'Không đủ chứng từ',
      ipAddress: '10.0.0.1',
      context: { requestId: 'request-1' },
      createdAt: new Date('2026-08-12T02:00:00.000Z')
    }]));
    mocks.countDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(21) });

    const result = await listAdminAuditLogs({
      page: 2,
      limit: 10,
      actionType: 'MANUAL_REJECT',
      adminId: 'admin-1',
      from: '2026-08-01',
      to: '2026-08-12'
    });

    expect(result).toMatchObject({ page: 2, limit: 10, total: 21, totalPages: 3 });
    expect(result.items[0]).toMatchObject({ actionId: 'action-1', actionType: 'MANUAL_REJECT' });
    expect(mocks.find.mock.results[0].value.skip).toHaveBeenCalledWith(10);
    expect(mocks.find.mock.results[0].value.limit).toHaveBeenCalledWith(10);
    expect(mocks.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ $and: expect.any(Array) }));

    const query = buildAuditLogQuery({ page: 1, limit: 20, actionType: 'MANUAL_REJECT', adminId: 'admin-1' });
    expect(JSON.stringify(query)).toContain('admin-1');
    expect(JSON.stringify(query)).toContain('MANUAL_REJECT');
    expect(query.$and).toContainEqual({
      $or: [{ actionType: 'MANUAL_REJECT' }, { action: 'MANUAL_REJECT' }]
    });
  });
});
