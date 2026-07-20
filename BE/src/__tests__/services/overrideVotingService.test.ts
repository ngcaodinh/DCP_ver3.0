import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  submitOverrideVote,
  VoteRejectedError
} from '../../services/overrideVotingService';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../models/oracleOverrideRequestModel', () => ({
  findOverrideRequestById: vi.fn(),
  addVoteToOverrideRequest: vi.fn(),
  resolveOverrideRequest: vi.fn(),
  expireOverrideRequest: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  findActiveCommissioners: vi.fn()
}));

// Redis không cần trong test — mock vi.fn() trả null mặc định (fallback về findActiveCommissioners).
// Một số test Redis path sẽ override mockReturnValue trong describe block riêng.
vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: vi.fn(),
  updateDisbursementByRequestIdWithCondition: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn().mockResolvedValue({})
}));

vi.mock('../../events/oracleEvents', () => ({
  oracleEvents: { emit: vi.fn() }
}));

import {
  findOverrideRequestById,
  addVoteToOverrideRequest,
  resolveOverrideRequest,
  expireOverrideRequest
} from '../../models/oracleOverrideRequestModel';
import { findActiveCommissioners } from '../../models/authModel';
import { getRedisClientIfReady } from '../../config/redis';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestIdWithCondition
} from '../../models/disbursementModel';
import { oracleEvents } from '../../events/oracleEvents';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SNAPSHOT = [
  { userId: 'admin-1', role: 'admin' },
  { userId: 'regulatory-1', role: 'regulatory' },
  { userId: 'admin-2', role: 'admin' }
];

function buildPendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    overrideRequestId: 'req-001',
    projectId: 'proj-001',
    organizationId: 'org-001',
    evidenceCid: 'cid-001',
    disbursementRequestId: null,
    status: 'PENDING',
    commissionerSnapshot: SNAPSHOT,
    votes: [],
    reason: 'OUT_OF_GEOFENCE',
    gpsFromImage: { lat: 10.0, lng: 106.0 },
    gpsFromProject: { lat: 10.1, lng: 106.1 },
    distanceMeters: 1500,
    resolvedAt: null,
    expiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

// commissioner set không thay đổi (trả về cùng userId+role với snapshot)
function mockUnchangedCommissionerSet() {
  vi.mocked(findActiveCommissioners).mockResolvedValue([
    { id: 'admin-1', role: 'admin' } as never,
    { id: 'regulatory-1', role: 'regulatory' } as never,
    { id: 'admin-2', role: 'admin' } as never
  ]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('submitOverrideVote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnchangedCommissionerSet();
  });

  // ─── Guard: request không tồn tại ────────────────────────────────────────
  it('ném VoteRejectedError REQUEST_NOT_FOUND khi request không tồn tại', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(null);

    await expect(
      submitOverrideVote('req-999', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).rejects.toThrow(new VoteRejectedError('REQUEST_NOT_FOUND'));
  });

  // ─── Guard: request không ở PENDING ──────────────────────────────────────
  it('ném VoteRejectedError REQUEST_NOT_PENDING khi request đã APPROVED', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest({ status: 'APPROVED' }) as never
    );

    await expect(
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).rejects.toThrow(new VoteRejectedError('REQUEST_NOT_PENDING'));
  });

  // ─── Guard: commissioner không trong snapshot ─────────────────────────────
  it('ném VoteRejectedError NOT_IN_SNAPSHOT khi commissioner không trong snapshot', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest() as never
    );

    await expect(
      submitOverrideVote('req-001', 'stranger-99', 'admin', 'APPROVE', 'ok')
    ).rejects.toThrow(new VoteRejectedError('NOT_IN_SNAPSHOT'));
  });

  // ─── Guard: đã vote rồi ───────────────────────────────────────────────────
  it('ném VoteRejectedError ALREADY_VOTED khi commissioner đã vote trước đó', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest({
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'lgtm', votedAt: new Date() }
        ]
      }) as never
    );
    // [B-NEW1 fix] addVoteToOverrideRequest trả về 'ALREADY_VOTED' khi atomic check fails
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('ALREADY_VOTED' as never);

    await expect(
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).rejects.toThrow(new VoteRejectedError('ALREADY_VOTED'));
  });

  // ─── Phát hiện commissioner set thay đổi ─────────────────────────────────
  it('expire request và trả EXPIRED_COMMISSIONER_SET_CHANGED khi commissioner set thay đổi', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest() as never
    );
    // Giả lập: regulatory-1 bị xóa, thêm new-admin vào
    vi.mocked(findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin' } as never,
      { id: 'new-admin', role: 'admin' } as never
    ]);
    vi.mocked(expireOverrideRequest).mockResolvedValue(buildPendingRequest({ status: 'EXPIRED' }) as never);

    const result = await submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok');

    expect(result.outcome).toBe('EXPIRED_COMMISSIONER_SET_CHANGED');
    expect(expireOverrideRequest).toHaveBeenCalledWith('req-001', expect.any(Date));
  });

  // ─── Ghi nhận vote (chưa đủ) ─────────────────────────────────────────────
  it('trả VOTE_RECORDED với pendingVoters đúng khi chưa đủ N vote', async () => {
    const initialRequest = buildPendingRequest();
    // Sau khi $push vote, request có 1 vote APPROVE, còn 2 người chưa vote
    const requestAfterVote = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    // [B-NEW1 fix] Service load request 2 lần: 1 cho check, 1 sau khi addVote trả OK
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterVote as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);

    const result = await submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok');

    expect(result.outcome).toBe('VOTE_RECORDED');
    if (result.outcome === 'VOTE_RECORDED') {
      expect(result.pendingVoters).toBe(2); // 3 tổng - 1 đã vote = 2 còn lại
      expect(result.totalVoters).toBe(3);
    }
    expect(resolveOverrideRequest).not.toHaveBeenCalled();
  });

  // ─── REJECT ngay khi có 1 phiếu REJECT ────────────────────────────────────
  it('resolve REJECTED ngay khi có bất kỳ phiếu REJECT', async () => {
    const initialRequest = buildPendingRequest();
    // Sau khi $push vote REJECT
    const requestAfterReject = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'REJECT', reason: 'invalid', votedAt: new Date() }
      ]
    });
    // [B-NEW1 fix] Service load request 2 lần
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterReject as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);
    vi.mocked(resolveOverrideRequest).mockResolvedValue(
      buildPendingRequest({ status: 'REJECTED', resolvedAt: new Date() }) as never
    );

    const result = await submitOverrideVote('req-001', 'admin-1', 'admin', 'REJECT', 'invalid location');

    expect(result.outcome).toBe('RESOLVED_REJECTED');
    expect(resolveOverrideRequest).toHaveBeenCalledWith('req-001', 'REJECTED', expect.any(Date));
  });

  // ─── APPROVED khi tất cả vote APPROVE (không có disbursement) ─────────────
  it('resolve APPROVED khi tất cả N commissioner vote APPROVE (không link disbursement)', async () => {
    const initialRequest = buildPendingRequest();
    // Vote cuối cùng (admin-2) → đủ 3/3
    const requestAfterFinalVote = buildPendingRequest({
      disbursementRequestId: null,
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    // [B-NEW1 fix] Service load request 2 lần
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterFinalVote as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);
    vi.mocked(resolveOverrideRequest).mockResolvedValue(
      buildPendingRequest({ status: 'APPROVED', resolvedAt: new Date() }) as never
    );

    const result = await submitOverrideVote('req-001', 'admin-2', 'admin', 'APPROVE', 'confirmed');

    expect(result.outcome).toBe('RESOLVED_APPROVED');
    if (result.outcome === 'RESOLVED_APPROVED') {
      expect(result.disbursementAutoApproved).toBe(false);
    }
    expect(oracleEvents.emit).toHaveBeenCalledWith('override.executed', expect.objectContaining({
      overrideRequestId: 'req-001'
    }));
  });

  // ─── APPROVED với disbursement auto-approve ───────────────────────────────
  it('auto-approve disbursement khi override APPROVED và có disbursementRequestId', async () => {
    const initialRequest = buildPendingRequest({ disbursementRequestId: 'disb-001' });
    const requestAfterFinalVote = buildPendingRequest({
      disbursementRequestId: 'disb-001',
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterFinalVote as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);
    vi.mocked(resolveOverrideRequest).mockResolvedValue(
      buildPendingRequest({ disbursementRequestId: 'disb-001', status: 'APPROVED', resolvedAt: new Date() }) as never
    );
    vi.mocked(findDisbursementByRequestId).mockResolvedValue(
      { requestId: 'disb-001', status: 'PENDING' } as never
    );
    vi.mocked(updateDisbursementByRequestIdWithCondition).mockResolvedValue(
      { requestId: 'disb-001', status: 'APPROVED' } as never
    );

    const result = await submitOverrideVote('req-001', 'admin-2', 'admin', 'APPROVE', 'confirmed');

    expect(result.outcome).toBe('RESOLVED_APPROVED');
    if (result.outcome === 'RESOLVED_APPROVED') {
      expect(result.disbursementAutoApproved).toBe(true);
    }
    expect(updateDisbursementByRequestIdWithCondition).toHaveBeenCalledWith(
      'disb-001',
      { status: 'PENDING' },
      { status: 'APPROVED' }
    );
  });

  // ─── Disbursement không còn PENDING khi auto-approve ─────────────────────
  it('disbursementAutoApproved = false khi disbursement không còn PENDING', async () => {
    const initialRequest = buildPendingRequest({ disbursementRequestId: 'disb-001' });
    const requestAfterFinalVote = buildPendingRequest({
      disbursementRequestId: 'disb-001',
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterFinalVote as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);
    vi.mocked(resolveOverrideRequest).mockResolvedValue(
      buildPendingRequest({ disbursementRequestId: 'disb-001', status: 'APPROVED', resolvedAt: new Date() }) as never
    );
    vi.mocked(findDisbursementByRequestId).mockResolvedValue(
      { requestId: 'disb-001', status: 'APPROVED' } as never
    );
    vi.mocked(updateDisbursementByRequestIdWithCondition).mockResolvedValue(null);

    const result = await submitOverrideVote('req-001', 'admin-2', 'admin', 'APPROVE', 'confirmed');

    expect(result.outcome).toBe('RESOLVED_APPROVED');
    if (result.outcome === 'RESOLVED_APPROVED') {
      expect(result.disbursementAutoApproved).toBe(false);
    }
  });

  // ─── Race condition: addVoteToOverrideRequest trả NOT_PENDING ────────────
  it('ném VoteRejectedError REQUEST_NOT_PENDING khi addVote trả NOT_PENDING (race condition)', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest() as never
    );
    mockUnchangedCommissionerSet();
    // [B-NEW1 fix] addVote trả 'NOT_PENDING' khi atomic findOneAndUpdate không match (concurrent resolve)
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('NOT_PENDING' as never);

    await expect(
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).rejects.toThrow(new VoteRejectedError('REQUEST_NOT_PENDING'));
  });

  // ─── T1: Role check trong detectCommissionerSetChange (B2-fix #1) ────────
  it('[T1] expire khi role của commissioner đổi dù userId vẫn khớp', async () => {
    vi.mocked(findOverrideRequestById).mockResolvedValue(
      buildPendingRequest() as never
    );
    // admin-1 vẫn ACTIVE nhưng role đã đổi từ 'admin' → 'donor' (không trong ACTIVE commissioner set)
    vi.mocked(findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'donor' } as never,   // demoted — không còn là commissioner
      { id: 'regulatory-1', role: 'regulatory' } as never,
      { id: 'admin-2', role: 'admin' } as never
    ]);
    vi.mocked(expireOverrideRequest).mockResolvedValue(
      buildPendingRequest({ status: 'EXPIRED' }) as never
    );

    const result = await submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok');

    // Tuple admin-1::admin (snapshot) ≠ admin-1::donor (hiện tại) → phải EXPIRED
    expect(result.outcome).toBe('EXPIRED_COMMISSIONER_SET_CHANGED');
    expect(expireOverrideRequest).toHaveBeenCalledWith('req-001', expect.any(Date));
  });

  // ─── T2: Disbursement đang EXECUTING khi auto-approve (B2-fix #3) ────────
  it('[T2] disbursementAutoApproved=false và không throw khi disbursement đang EXECUTING', async () => {
    const initialRequest = buildPendingRequest({ disbursementRequestId: 'disb-001' });
    const requestAfterFinalVote = buildPendingRequest({
      disbursementRequestId: 'disb-001',
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    // [B-NEW1 fix] Service load request 2 lần
    vi.mocked(findOverrideRequestById)
      .mockResolvedValueOnce(initialRequest as never)
      .mockResolvedValueOnce(requestAfterFinalVote as never);
    mockUnchangedCommissionerSet();
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);
    vi.mocked(resolveOverrideRequest).mockResolvedValue(
      buildPendingRequest({ disbursementRequestId: 'disb-001', status: 'APPROVED', resolvedAt: new Date() }) as never
    );
    // Disbursement đang EXECUTING — race condition với PayOS
    vi.mocked(findDisbursementByRequestId).mockResolvedValue(
      { requestId: 'disb-001', status: 'EXECUTING' } as never
    );
    vi.mocked(updateDisbursementByRequestIdWithCondition).mockResolvedValue(null);

    const result = await submitOverrideVote('req-001', 'admin-2', 'admin', 'APPROVE', 'ok');

    expect(result.outcome).toBe('RESOLVED_APPROVED');
    if (result.outcome === 'RESOLVED_APPROVED') {
      expect(result.disbursementAutoApproved).toBe(false);
    }
  });

  // ─── T3: Race condition — 3 APPROVE đồng thời qua Promise.all ────────────
  it('[T3] chỉ 1 winner resolve APPROVED khi 3 vote APPROVE gần như cùng lúc', async () => {
    const fullVoteRequest = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'ok', votedAt: new Date() },
        { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    // Mỗi concurrent vote cần load request — dùng mockResolvedValue (luôn trả về cùng giá trị)
    vi.mocked(findOverrideRequestById).mockResolvedValue(fullVoteRequest as never);
    mockUnchangedCommissionerSet();
    // [B-NEW1 fix] addVote trả 'OK' cho cả 3 vì dùng atomic check
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue('OK' as never);

    // Chỉ 1 trong 3 resolve thành công (winner), 2 còn lại trả null (loser — race)
    vi.mocked(resolveOverrideRequest)
      .mockResolvedValueOnce(buildPendingRequest({ status: 'APPROVED', resolvedAt: new Date() }) as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const results = await Promise.all([
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok'),
      submitOverrideVote('req-001', 'regulatory-1', 'regulatory', 'APPROVE', 'ok'),
      submitOverrideVote('req-001', 'admin-2', 'admin', 'APPROVE', 'ok')
    ]);

    const approvedCount = results.filter(r => r.outcome === 'RESOLVED_APPROVED').length;
    const recordedCount = results.filter(r => r.outcome === 'VOTE_RECORDED').length;
    expect(approvedCount).toBe(1);
    expect(recordedCount).toBe(2);
    // Chỉ emit event 1 lần — winner emit, loser không emit vì resolved=null
    expect(vi.mocked(oracleEvents.emit)).toHaveBeenCalledTimes(1);
  });
});

// ─── Tests: getCachedActiveCommissioners — Redis paths ───────────────────────
// Hàm private, test gián tiếp qua submitOverrideVote (được gọi ngầm qua
// detectCommissionerSetChange → getCachedActiveCommissioners).

describe('getCachedActiveCommissioners — Redis cache paths (T3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[T3a] Cache HIT → trả cached data, KHÔNG gọi findActiveCommissioners', async () => {
    // Giả lập Redis có dữ liệu cache
    const cachedCommissioners = [
      { id: 'admin-1', role: 'admin' },
      { id: 'regulatory-1', role: 'regulatory' },
      { id: 'admin-2', role: 'admin' }
    ];
    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedCommissioners)),
      setEx: vi.fn()
    };
    vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedis as never);

    // Setup request PENDING — commissioner set khớp cache → không EXPIRED
    vi.mocked(findOverrideRequestById).mockResolvedValue(buildPendingRequest() as never);
    const requestAfterVote = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue(requestAfterVote as never);

    const result = await submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok');

    // Cache HIT → findActiveCommissioners KHÔNG được gọi (dùng cached data)
    expect(findActiveCommissioners).not.toHaveBeenCalled();
    expect(mockRedis.get).toHaveBeenCalled();
    // Vote thành công vì commissioner set không thay đổi
    expect(result.outcome).toBe('VOTE_RECORDED');
  });

  it('[T3b] redis.setEx throw → vẫn trả fresh data từ DB, không throw lên caller', async () => {
    // Cache MISS → setEx thất bại khi ghi cache
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),                // cache miss
      setEx: vi.fn().mockRejectedValue(new Error('Redis write timeout'))
    };
    vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedis as never);

    // findActiveCommissioners vẫn trả data (DB fallback)
    vi.mocked(findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin' } as never,
      { id: 'regulatory-1', role: 'regulatory' } as never,
      { id: 'admin-2', role: 'admin' } as never
    ]);

    vi.mocked(findOverrideRequestById).mockResolvedValue(buildPendingRequest() as never);
    const requestAfterVote = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue(requestAfterVote as never);

    // setEx lỗi KHÔNG được bubble lên — vote flow vẫn thành công
    await expect(
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).resolves.toMatchObject({ outcome: 'VOTE_RECORDED' });

    // DB đã được gọi để lấy fresh data dù cache lỗi
    expect(findActiveCommissioners).toHaveBeenCalled();
  });

  it('[T3c] redis.get trả invalid JSON → fallback DB, không throw', async () => {
    // Cache trả string không phải JSON hợp lệ — corrupt data
    const mockRedis = {
      get: vi.fn().mockResolvedValue('{ invalid json %%%'),
      setEx: vi.fn()
    };
    vi.mocked(getRedisClientIfReady).mockReturnValue(mockRedis as never);

    // DB fallback sau khi JSON.parse lỗi
    vi.mocked(findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin' } as never,
      { id: 'regulatory-1', role: 'regulatory' } as never,
      { id: 'admin-2', role: 'admin' } as never
    ]);

    vi.mocked(findOverrideRequestById).mockResolvedValue(buildPendingRequest() as never);
    const requestAfterVote = buildPendingRequest({
      votes: [
        { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'ok', votedAt: new Date() }
      ]
    });
    vi.mocked(addVoteToOverrideRequest).mockResolvedValue(requestAfterVote as never);

    // Invalid JSON trong Redis KHÔNG được crash vote flow
    await expect(
      submitOverrideVote('req-001', 'admin-1', 'admin', 'APPROVE', 'ok')
    ).resolves.toMatchObject({ outcome: 'VOTE_RECORDED' });

    // Phải fallback sang DB sau khi Redis cache corrupt
    expect(findActiveCommissioners).toHaveBeenCalled();
  });
});
