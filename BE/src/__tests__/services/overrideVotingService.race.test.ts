import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitOverrideVote, VoteRejectedError } from '../../services/overrideVotingService';
import * as overrideModel from '../../models/oracleOverrideRequestModel';
import * as authModel from '../../models/authModel';
import type { OracleOverrideRequestRecord } from '../../models/oracleOverrideRequestModel';

vi.mock('../../models/oracleOverrideRequestModel');
vi.mock('../../models/authModel');
vi.mock('../../models/disbursementModel');
vi.mock('../../models/adminAuditLogModel');
vi.mock('../../services/multisigOverrideLog.service');
vi.mock('../../services/notificationService');
vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

describe('overrideVotingService — Race Condition Tests (B-NEW1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test case chính cho B-NEW1: Verify một commissioner không thể vote nhiều lần
   * ngay cả khi gửi nhiều request đồng thời (Promise.all).
   * 
   * Kịch bản: 3 request cùng một commissionerId gọi submitOverrideVote đồng thời.
   * Kỳ vọng: Chỉ 1 request thành công, 2 request còn lại nhận ALREADY_VOTED error.
   */
  it('should reject duplicate votes from same commissionerId when submitted concurrently', async () => {
    const mockOverrideRequest: OracleOverrideRequestRecord = {
      overrideRequestId: 'test-override-001',
      verificationId: 'ver-001',
      projectId: 'proj-001',
      organizationId: 'org-001',
      evidenceCid: 'QmTest123',
      disbursementRequestId: null,
      reason: 'OUT_OF_GEOFENCE',
      gpsFromImage: { lat: 10.8, lng: 106.7 },
      gpsFromProject: { lat: 10.9, lng: 106.8 },
      distanceMeters: 15000,
      commissionerSnapshot: [
        { userId: 'admin-1', role: 'admin' },
        { userId: 'admin-2', role: 'admin' },
        { userId: 'regulatory-1', role: 'regulatory' }
      ],
      votes: [],
      status: 'PENDING',
      resolvedAt: null,
      expiredAt: null,
      createdAt: new Date('2026-07-10T10:00:00Z'),
      updatedAt: new Date('2026-07-10T10:00:00Z')
    };

    // Mock findOverrideRequestById — luôn trả override request PENDING với votes rỗng ban đầu
    vi.mocked(overrideModel.findOverrideRequestById).mockResolvedValue(mockOverrideRequest);

    // Mock findActiveCommissioners — danh sách khớp với snapshot
    vi.mocked(authModel.findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin', email: 'admin1@test.com', status: 'active' } as any,
      { id: 'admin-2', role: 'admin', email: 'admin2@test.com', status: 'active' } as any,
      { id: 'regulatory-1', role: 'regulatory', email: 'reg1@test.com', status: 'active' } as any
    ]);

    let firstCallSucceeded = false;

    /**
     * Mock addVoteToOverrideRequest — simulate atomic behavior:
     * - Lần gọi đầu tiên: trả 'OK' và đánh dấu firstCallSucceeded = true
     * - Các lần gọi sau: trả 'ALREADY_VOTED' (giả lập DB đã có votes.commissionerId)
     */
    vi.mocked(overrideModel.addVoteToOverrideRequest).mockImplementation(async () => {
      if (!firstCallSucceeded) {
        firstCallSucceeded = true;
        return 'OK';
      }
      return 'ALREADY_VOTED';
    });

    // Gọi 3 lần submitOverrideVote đồng thời với cùng commissionerId
    const results = await Promise.allSettled([
      submitOverrideVote('test-override-001', 'admin-1', 'admin', 'APPROVE', 'GPS hợp lệ'),
      submitOverrideVote('test-override-001', 'admin-1', 'admin', 'APPROVE', 'GPS hợp lệ'),
      submitOverrideVote('test-override-001', 'admin-1', 'admin', 'APPROVE', 'GPS hợp lệ')
    ]);

    const fulfilledCount = results.filter(r => r.status === 'fulfilled').length;
    const rejectedWithAlreadyVoted = results.filter(
      r => r.status === 'rejected' && 
           (r.reason as VoteRejectedError).rejectionReason === 'ALREADY_VOTED'
    ).length;

    // Assert: Chỉ 1 lần thành công, 2 lần bị reject với ALREADY_VOTED
    expect(fulfilledCount).toBe(1);
    expect(rejectedWithAlreadyVoted).toBe(2);

    // Verify addVoteToOverrideRequest được gọi 3 lần (do 3 concurrent requests)
    expect(overrideModel.addVoteToOverrideRequest).toHaveBeenCalledTimes(3);
  });

  /**
   * Test case bổ sung: Verify rằng KHÔNG có outcome RESOLVED_APPROVED
   * khi chỉ có 1 commissioner vote (ngay cả khi vote được ghi 3 lần do bug).
   * 
   * Đây là test kiểm tra invariant: multisig 3-of-3 không thể bị phá vỡ bởi 1 actor.
   */
  it('should NOT auto-approve override when only 1 unique commissioner voted (even if race allowed duplicates)', async () => {
    const mockOverrideRequest: OracleOverrideRequestRecord = {
      overrideRequestId: 'test-override-002',
      verificationId: 'ver-002',
      projectId: 'proj-002',
      organizationId: 'org-002',
      evidenceCid: 'QmTest456',
      disbursementRequestId: 'disb-002',
      reason: 'OUT_OF_GEOFENCE',
      gpsFromImage: { lat: 10.8, lng: 106.7 },
      gpsFromProject: { lat: 10.9, lng: 106.8 },
      distanceMeters: 15000,
      commissionerSnapshot: [
        { userId: 'admin-1', role: 'admin' },
        { userId: 'admin-2', role: 'admin' },
        { userId: 'regulatory-1', role: 'regulatory' }
      ],
      votes: [],
      status: 'PENDING',
      resolvedAt: null,
      expiredAt: null,
      createdAt: new Date('2026-07-10T11:00:00Z'),
      updatedAt: new Date('2026-07-10T11:00:00Z')
    };

    vi.mocked(overrideModel.findOverrideRequestById).mockResolvedValue(mockOverrideRequest);
    vi.mocked(authModel.findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin', email: 'admin1@test.com', status: 'active' } as any,
      { id: 'admin-2', role: 'admin', email: 'admin2@test.com', status: 'active' } as any,
      { id: 'regulatory-1', role: 'regulatory', email: 'reg1@test.com', status: 'active' } as any
    ]);

    // Mock addVoteToOverrideRequest — chỉ cho phép 1 lần thành công
    let voteRecorded = false;
    vi.mocked(overrideModel.addVoteToOverrideRequest).mockImplementation(async () => {
      if (!voteRecorded) {
        voteRecorded = true;
        return 'OK';
      }
      return 'ALREADY_VOTED';
    });

    // Mock findOverrideRequestById lần thứ 2 (sau khi ghi vote) — trả về request với 1 vote duy nhất
    vi.mocked(overrideModel.findOverrideRequestById).mockResolvedValueOnce(mockOverrideRequest);
    vi.mocked(overrideModel.findOverrideRequestById).mockResolvedValueOnce({
      ...mockOverrideRequest,
      votes: [
        {
          commissionerId: 'admin-1',
          commissionerRole: 'admin',
          vote: 'APPROVE',
          reason: 'GPS hợp lệ',
          votedAt: new Date()
        }
      ]
    });

    // Gọi submitOverrideVote 1 lần với admin-1
    const result = await submitOverrideVote(
      'test-override-002',
      'admin-1',
      'admin',
      'APPROVE',
      'GPS hợp lệ'
    );

    // Assert: outcome phải là VOTE_RECORDED, không phải RESOLVED_APPROVED
    expect(result.outcome).toBe('VOTE_RECORDED');
    if (result.outcome === 'VOTE_RECORDED') {
      expect(result.pendingVoters).toBe(2); // Còn 2 commissioner chưa vote
      expect(result.totalVoters).toBe(3);
    }

    // Verify resolveOverrideRequest KHÔNG được gọi
    expect(overrideModel.resolveOverrideRequest).not.toHaveBeenCalled();
  });

  /**
   * Test case: Verify rằng khi 3 commissioner khác nhau vote,
   * outcome là RESOLVED_APPROVED (happy path).
   */
  it('should approve override when all 3 distinct commissioners vote APPROVE', async () => {
    const mockOverrideRequest: OracleOverrideRequestRecord = {
      overrideRequestId: 'test-override-003',
      verificationId: 'ver-003',
      projectId: 'proj-003',
      organizationId: 'org-003',
      evidenceCid: 'QmTest789',
      disbursementRequestId: null,
      reason: 'OUT_OF_GEOFENCE',
      gpsFromImage: { lat: 10.8, lng: 106.7 },
      gpsFromProject: { lat: 10.9, lng: 106.8 },
      distanceMeters: 15000,
      commissionerSnapshot: [
        { userId: 'admin-1', role: 'admin' },
        { userId: 'admin-2', role: 'admin' },
        { userId: 'regulatory-1', role: 'regulatory' }
      ],
      votes: [],
      status: 'PENDING',
      resolvedAt: null,
      expiredAt: null,
      createdAt: new Date('2026-07-10T12:00:00Z'),
      updatedAt: new Date('2026-07-10T12:00:00Z')
    };

    vi.mocked(authModel.findActiveCommissioners).mockResolvedValue([
      { id: 'admin-1', role: 'admin', email: 'admin1@test.com', status: 'active' } as any,
      { id: 'admin-2', role: 'admin', email: 'admin2@test.com', status: 'active' } as any,
      { id: 'regulatory-1', role: 'regulatory', email: 'reg1@test.com', status: 'active' } as any
    ]);

    // Mock addVoteToOverrideRequest — luôn trả 'OK' (giả lập 3 commissioner khác nhau vote)
    vi.mocked(overrideModel.addVoteToOverrideRequest).mockResolvedValue('OK');

    // Mock findOverrideRequestById — trả về request với 0, 1, 2, 3 votes tương ứng
    vi.mocked(overrideModel.findOverrideRequestById)
      .mockResolvedValueOnce(mockOverrideRequest) // Load ban đầu (0 votes)
      .mockResolvedValueOnce({ // Sau vote 1
        ...mockOverrideRequest,
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'OK', votedAt: new Date() }
        ]
      })
      .mockResolvedValueOnce(mockOverrideRequest) // Load ban đầu cho vote 2
      .mockResolvedValueOnce({ // Sau vote 2
        ...mockOverrideRequest,
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'OK', votedAt: new Date() },
          { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'OK', votedAt: new Date() }
        ]
      })
      .mockResolvedValueOnce(mockOverrideRequest) // Load ban đầu cho vote 3
      .mockResolvedValueOnce({ // Sau vote 3 (đủ 3/3)
        ...mockOverrideRequest,
        votes: [
          { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'OK', votedAt: new Date() },
          { commissionerId: 'admin-2', commissionerRole: 'admin', vote: 'APPROVE', reason: 'OK', votedAt: new Date() },
          { commissionerId: 'regulatory-1', commissionerRole: 'regulatory', vote: 'APPROVE', reason: 'OK', votedAt: new Date() }
        ]
      });

    // Mock resolveOverrideRequest — trả về request đã APPROVED
    vi.mocked(overrideModel.resolveOverrideRequest).mockResolvedValue({
      ...mockOverrideRequest,
      status: 'APPROVED',
      resolvedAt: new Date()
    });

    // Vote lần 1: admin-1
    const result1 = await submitOverrideVote('test-override-003', 'admin-1', 'admin', 'APPROVE', 'OK');
    expect(result1.outcome).toBe('VOTE_RECORDED');

    // Vote lần 2: admin-2
    const result2 = await submitOverrideVote('test-override-003', 'admin-2', 'admin', 'APPROVE', 'OK');
    expect(result2.outcome).toBe('VOTE_RECORDED');

    // Vote lần 3: regulatory-1 (đủ 3/3 → APPROVED)
    const result3 = await submitOverrideVote('test-override-003', 'regulatory-1', 'regulatory', 'APPROVE', 'OK');
    expect(result3.outcome).toBe('RESOLVED_APPROVED');

    // Verify resolveOverrideRequest được gọi với status APPROVED
    expect(overrideModel.resolveOverrideRequest).toHaveBeenCalledWith(
      'test-override-003',
      'APPROVED',
      expect.any(Date)
    );
  });
});
