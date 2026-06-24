import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OracleOverrideRequestRecord, CommissionerVote } from '../../models/oracleOverrideRequestModel';

// ─── Mock dependencies — dùng vi.hoisted để tránh hoisting issues ─────────────

const { mockCreateMultisigOverrideLog, mockGetLoggerInfo, mockGetLoggerError } = vi.hoisted(() => {
  return {
    mockCreateMultisigOverrideLog: vi.fn(),
    mockGetLoggerInfo: vi.fn(),
    mockGetLoggerError: vi.fn(),
  };
});

vi.mock('../../models/multisigOverrideLogModel', () => ({
  createMultisigOverrideLog: mockCreateMultisigOverrideLog,
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: mockGetLoggerInfo,
    warn: vi.fn(),
    error: mockGetLoggerError,
    debug: vi.fn(),
  }),
}));

import {
  logOverrideApproved,
  logOverrideRejected,
  logOverrideExpired,
} from '../../services/multisigOverrideLog.service';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildOverrideRequest(overrides: Partial<OracleOverrideRequestRecord> = {}): OracleOverrideRequestRecord {
  return {
    overrideRequestId: 'req-001',
    verificationId: 'ver-001',
    projectId: 'proj-001',
    organizationId: 'org-001',
    evidenceCid: 'cid-001',
    disbursementRequestId: null,
    reason: 'OUT_OF_GEOFENCE',
    gpsFromImage: { lat: 10.0, lng: 106.0 },
    gpsFromProject: { lat: 10.1, lng: 106.1 },
    distanceMeters: 1500,
    commissionerSnapshot: [
      { userId: 'admin-1', role: 'admin' },
      { userId: 'regulatory-1', role: 'regulatory' },
    ],
    votes: [],
    status: 'APPROVED',
    resolvedAt: new Date('2024-01-15T10:00:00Z'),
    expiredAt: null,
    createdAt: new Date('2024-01-15T09:00:00Z'),
    updatedAt: new Date('2024-01-15T10:00:00Z'),
    ...overrides,
  } as OracleOverrideRequestRecord;
}

function buildCommissionerVote(overrides: Partial<CommissionerVote> = {}): CommissionerVote {
  return {
    commissionerId: 'admin-1',
    commissionerRole: 'admin',
    vote: 'APPROVE',
    reason: 'Location verified manually',
    votedAt: new Date('2024-01-15T09:30:00Z'),
    ...overrides,
  };
}

// ─── Tests: logOverrideApproved ────────────────────────────────────────────────

describe('logOverrideApproved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMultisigOverrideLog.mockResolvedValue({} as never);
  });

  it('gọi createMultisigOverrideLog với đúng fields khi disbursementAutoApproved=true', async () => {
    const request = buildOverrideRequest({
      disbursementRequestId: 'disb-001',
      resolvedAt: new Date('2024-01-15T10:00:00Z'),
    });
    const approvingVote = buildCommissionerVote({
      commissionerId: 'admin-1',
      commissionerRole: 'admin',
    });

    await logOverrideApproved(request, approvingVote, true);

    expect(mockCreateMultisigOverrideLog).toHaveBeenCalledOnce();
    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.overrideRequestId).toBe('req-001');
    expect(calledArgs.projectId).toBe('proj-001');
    expect(calledArgs.operator).toBe('admin-1');
    expect(calledArgs.operatorRole).toBe('admin');
    expect(calledArgs.action).toBe('OVERRIDE_VOTE_APPROVE');
    expect(calledArgs.resolution).toBe('APPROVED');
    expect(calledArgs.reason).toBe('Location verified manually');
    expect(calledArgs.txHash).toBeNull();
    expect(calledArgs.blockNumber).toBeNull();
    expect(calledArgs.eventTimestamp).toEqual(new Date('2024-01-15T10:00:00Z'));
    expect(calledArgs.metadata).toEqual({ disbursementAutoApproved: true });
  });

  it('gọi createMultisigOverrideLog với đúng fields khi disbursementAutoApproved=false', async () => {
    const request = buildOverrideRequest({
      disbursementRequestId: null,
      resolvedAt: new Date('2024-01-15T10:00:00Z'),
    });
    const approvingVote = buildCommissionerVote({
      commissionerId: 'regulatory-1',
      commissionerRole: 'regulatory',
      reason: 'Manual check passed',
    });

    await logOverrideApproved(request, approvingVote, false);

    expect(mockCreateMultisigOverrideLog).toHaveBeenCalledOnce();
    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.operator).toBe('regulatory-1');
    expect(calledArgs.operatorRole).toBe('regulatory');
    expect(calledArgs.reason).toBe('Manual check passed');
    expect(calledArgs.metadata).toEqual({ disbursementAutoApproved: false });
  });

  it('sử dụng resolvedAt làm eventTimestamp', async () => {
    const customResolvedAt = new Date('2024-06-01T12:30:00Z');
    const request = buildOverrideRequest({ resolvedAt: customResolvedAt });
    const vote = buildCommissionerVote();

    await logOverrideApproved(request, vote, true);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp).toEqual(customResolvedAt);
  });

  it('sử dụng new Date() làm eventTimestamp khi resolvedAt=null', async () => {
    const request = buildOverrideRequest({ resolvedAt: null });
    const vote = buildCommissionerVote();
    const before = new Date();

    await logOverrideApproved(request, vote, true);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(calledArgs.eventTimestamp.getTime()).toBeLessThanOrEqual(new Date().getTime());
  });

  it('không throw khi createMultisigOverrideLog ném error — chỉ log error', async () => {
    const error = new Error('Database write failed');
    mockCreateMultisigOverrideLog.mockRejectedValue(error);

    const request = buildOverrideRequest();
    const vote = buildCommissionerVote();

    // Should not throw
    await expect(logOverrideApproved(request, vote, true)).resolves.not.toThrow();

    expect(mockGetLoggerError).toHaveBeenCalledWith(
      'Lỗi khi ghi multisig_override_log cho override APPROVED',
      expect.objectContaining({ error: 'Database write failed' })
    );
  });

  it('ghi log info thành công khi tạo record thành công', async () => {
    const request = buildOverrideRequest();
    const vote = buildCommissionerVote();

    await logOverrideApproved(request, vote, true);

    expect(mockGetLoggerInfo).toHaveBeenCalledWith(
      'Đã ghi multisig_override_log APPROVED',
      expect.objectContaining({ overrideRequestId: 'req-001' })
    );
  });
});

// ─── Tests: logOverrideRejected ─────────────────────────────────────────────────

describe('logOverrideRejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMultisigOverrideLog.mockResolvedValue({} as never);
  });

  it('gọi createMultisigOverrideLog với action=OVERRIDE_VOTE_REJECT và resolution=REJECTED', async () => {
    const request = buildOverrideRequest({
      status: 'REJECTED',
      resolvedAt: new Date('2024-01-15T10:00:00Z'),
    });
    const rejectingVote = buildCommissionerVote({
      commissionerId: 'regulatory-1',
      commissionerRole: 'regulatory',
      vote: 'REJECT',
      reason: 'Evidence does not match project location',
    });

    await logOverrideRejected(request, rejectingVote);

    expect(mockCreateMultisigOverrideLog).toHaveBeenCalledOnce();
    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.overrideRequestId).toBe('req-001');
    expect(calledArgs.projectId).toBe('proj-001');
    expect(calledArgs.operator).toBe('regulatory-1');
    expect(calledArgs.operatorRole).toBe('regulatory');
    expect(calledArgs.action).toBe('OVERRIDE_VOTE_REJECT');
    expect(calledArgs.resolution).toBe('REJECTED');
    expect(calledArgs.reason).toBe('Evidence does not match project location');
    expect(calledArgs.txHash).toBeNull();
    expect(calledArgs.blockNumber).toBeNull();
    expect(calledArgs.eventTimestamp).toEqual(new Date('2024-01-15T10:00:00Z'));
    expect(calledArgs.metadata).toEqual({});
  });

  it('sử dụng rejectingVote.commissionerId làm operator', async () => {
    const request = buildOverrideRequest();
    const vote = buildCommissionerVote({
      commissionerId: 'admin-1',
      commissionerRole: 'admin',
    });

    await logOverrideRejected(request, vote);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.operator).toBe('admin-1');
    expect(calledArgs.operatorRole).toBe('admin');
  });

  it('sử dụng resolvedAt làm eventTimestamp', async () => {
    const customResolvedAt = new Date('2024-06-01T14:00:00Z');
    const request = buildOverrideRequest({ resolvedAt: customResolvedAt });
    const vote = buildCommissionerVote();

    await logOverrideRejected(request, vote);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp).toEqual(customResolvedAt);
  });

  it('sử dụng new Date() làm eventTimestamp khi resolvedAt=null', async () => {
    const request = buildOverrideRequest({ resolvedAt: null });
    const vote = buildCommissionerVote();
    const before = new Date();

    await logOverrideRejected(request, vote);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(calledArgs.eventTimestamp.getTime()).toBeLessThanOrEqual(new Date().getTime());
  });

  it('không throw khi createMultisigOverrideLog ném error — chỉ log error', async () => {
    const error = new Error('MongoDB connection lost');
    mockCreateMultisigOverrideLog.mockRejectedValue(error);

    const request = buildOverrideRequest();
    const vote = buildCommissionerVote();

    await expect(logOverrideRejected(request, vote)).resolves.not.toThrow();

    expect(mockGetLoggerError).toHaveBeenCalledWith(
      'Lỗi khi ghi multisig_override_log cho override REJECTED',
      expect.objectContaining({ error: 'MongoDB connection lost' })
    );
  });

  it('ghi log info thành công khi tạo record thành công', async () => {
    const request = buildOverrideRequest();
    const vote = buildCommissionerVote();

    await logOverrideRejected(request, vote);

    expect(mockGetLoggerInfo).toHaveBeenCalledWith(
      'Đã ghi multisig_override_log REJECTED',
      expect.objectContaining({ overrideRequestId: 'req-001' })
    );
  });
});

// ─── Tests: logOverrideExpired ──────────────────────────────────────────────────

describe('logOverrideExpired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMultisigOverrideLog.mockResolvedValue({} as never);
  });

  it('gọi createMultisigOverrideLog với action=OVERRIDE_EXPIRED và resolution=EXPIRED', async () => {
    const request = buildOverrideRequest({
      status: 'EXPIRED',
      expiredAt: new Date('2024-01-15T11:00:00Z'),
    });
    const expiredByCommissionerId = 'admin-1';

    await logOverrideExpired(request, expiredByCommissionerId);

    expect(mockCreateMultisigOverrideLog).toHaveBeenCalledOnce();
    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.overrideRequestId).toBe('req-001');
    expect(calledArgs.projectId).toBe('proj-001');
    expect(calledArgs.operator).toBe('admin-1');
    expect(calledArgs.operatorRole).toBe('');
    expect(calledArgs.action).toBe('OVERRIDE_EXPIRED');
    expect(calledArgs.resolution).toBe('EXPIRED');
    expect(calledArgs.txHash).toBeNull();
    expect(calledArgs.blockNumber).toBeNull();
    expect(calledArgs.eventTimestamp).toEqual(new Date('2024-01-15T11:00:00Z'));
  });

  it('sử dụng expiredByCommissionerId làm operator', async () => {
    const request = buildOverrideRequest();
    const expiredByCommissionerId = 'regulatory-1';

    await logOverrideExpired(request, expiredByCommissionerId);

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.operator).toBe('regulatory-1');
  });

  it('sử dụng expiredAt làm eventTimestamp thay vì resolvedAt', async () => {
    const expiredAt = new Date('2024-06-01T16:00:00Z');
    const request = buildOverrideRequest({
      status: 'EXPIRED',
      expiredAt,
      resolvedAt: new Date('2024-01-15T10:00:00Z'), // resolvedAt khác với expiredAt
    });

    await logOverrideExpired(request, 'admin-1');

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp).toEqual(expiredAt);
    expect(calledArgs.eventTimestamp).not.toEqual(request.resolvedAt);
  });

  it('sử dụng new Date() làm eventTimestamp khi expiredAt=null', async () => {
    const request = buildOverrideRequest({ expiredAt: null });
    const before = new Date();

    await logOverrideExpired(request, 'admin-1');

    const calledArgs = mockCreateMultisigOverrideLog.mock.calls[0][0];
    expect(calledArgs.eventTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(calledArgs.eventTimestamp.getTime()).toBeLessThanOrEqual(new Date().getTime());
  });

  it('không throw khi createMultisigOverrideLog ném error — chỉ log error', async () => {
    const error = new Error('Write concern timeout');
    mockCreateMultisigOverrideLog.mockRejectedValue(error);

    const request = buildOverrideRequest();
    const expiredByCommissionerId = 'admin-1';

    await expect(logOverrideExpired(request, expiredByCommissionerId)).resolves.not.toThrow();

    expect(mockGetLoggerError).toHaveBeenCalledWith(
      'Lỗi khi ghi multisig_override_log cho override EXPIRED',
      expect.objectContaining({ error: 'Write concern timeout' })
    );
  });

  it('ghi log info thành công khi tạo record thành công', async () => {
    const request = buildOverrideRequest();
    const expiredByCommissionerId = 'admin-1';

    await logOverrideExpired(request, expiredByCommissionerId);

    expect(mockGetLoggerInfo).toHaveBeenCalledWith(
      'Đã ghi multisig_override_log EXPIRED',
      expect.objectContaining({ overrideRequestId: 'req-001' })
    );
  });
});
