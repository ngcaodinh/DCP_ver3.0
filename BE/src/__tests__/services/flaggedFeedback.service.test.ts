import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFeedback: vi.fn(),
  countFeedback: vi.fn(),
  findProjectNames: vi.fn(),
  findAudits: vi.fn()
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  listFlaggedBeneficiaryFeedback: mocks.listFeedback,
  countFlaggedBeneficiaryFeedback: mocks.countFeedback
}));
vi.mock('../../models/projectModel', () => ({
  findProjectNamesByProjectIdList: mocks.findProjectNames
}));
vi.mock('../../models/adminAuditLogModel', () => ({
  findLatestFlagAuditsByFeedbackIds: mocks.findAudits
}));

import { listFlaggedFeedback } from '../../services/flaggedFeedback.service';

const now = new Date('2026-08-15T00:00:00.000Z');

function createFeedback(overrides: Record<string, unknown> = {}) {
  return {
    feedbackId: 'fb-1',
    projectId: 'project-1',
    rating: 5,
    comment: 'tuyetvoiiiii',
    submittedAt: new Date('2026-08-10T03:12:00.000Z'),
    location: 'Quảng Bình',
    riskScore: 8,
    isFlagged: true,
    source: 'public' as const,
    createdAt: new Date('2026-08-10T03:12:00.000Z'),
    updatedAt: new Date('2026-08-10T03:12:00.000Z'),
    ...overrides
  };
}

describe('flaggedFeedback.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listFeedback.mockResolvedValue([]);
    mocks.countFeedback.mockResolvedValue(0);
    mocks.findProjectNames.mockResolvedValue([]);
    mocks.findAudits.mockResolvedValue(new Map());
  });

  it('lấy active theo risk/submittedAt, batch project name và audit trong lô', async () => {
    mocks.listFeedback.mockResolvedValue([createFeedback({ feedbackId: 'fb-manual' })]);
    mocks.countFeedback.mockResolvedValue(1);
    mocks.findProjectNames.mockResolvedValue([{ projectId: 'project-1', name: 'Dự án Quảng Bình' }]);
    mocks.findAudits.mockResolvedValue(new Map([
      ['fb-manual', {
        createdAt: new Date('2026-08-14T01:00:00.000Z'),
        reason: 'Trùng nội dung với feedback khác',
        adminId: 'admin-7',
        context: { reason: 'legacy reason' }
      }]
    ]));

    const result = await listFlaggedFeedback({ page: 1, limit: 20, deletionState: 'active' }, now);

    expect(mocks.listFeedback).toHaveBeenCalledWith(
      {
        deletionState: 'active',
        projectId: undefined,
        minRiskScore: undefined,
        source: undefined,
        skip: 0,
        limit: 20
      }
    );
    expect(mocks.countFeedback).toHaveBeenCalledWith(expect.objectContaining({ deletionState: 'active', skip: 0, limit: 20 }));
    expect(mocks.findProjectNames).toHaveBeenCalledWith(['project-1']);
    expect(mocks.findAudits).toHaveBeenCalledWith(['fb-manual']);
    expect(result.items[0]).toMatchObject({
      projectName: 'Dự án Quảng Bình',
      flagReason: {
        kind: 'MANUAL',
        adminReason: 'Trùng nội dung với feedback khác',
        flaggedByAdminId: 'admin-7'
      }
    });
  });

  it('phân giải AUTO/UNKNOWN và luôn trả indicators mà không phát hành PII', async () => {
    mocks.listFeedback.mockResolvedValue([
      createFeedback({ feedbackId: 'fb-auto', riskScore: 7 }),
      createFeedback({ feedbackId: 'fb-unknown', riskScore: 6, beneficiaryNameHash: 'secret', submissionIpHash: 'secret' })
    ]);
    mocks.countFeedback.mockResolvedValue(2);

    const result = await listFlaggedFeedback({ page: 1, limit: 20, deletionState: 'active' }, now);

    expect(result.items[0].flagReason.kind).toBe('AUTO');
    expect(result.items[0].flagReason.indicators).toContain('extreme_rating:5');
    expect(result.items[1].flagReason.kind).toBe('UNKNOWN');
    expect(result.items[1]).not.toHaveProperty('beneficiaryNameHash');
    expect(result.items[1]).not.toHaveProperty('submissionIpHash');
  });

  it('liệt kê deleted với project null và tính daysUntilPurge ở biên 30/1/0', async () => {
    mocks.listFeedback.mockResolvedValue([
      createFeedback({ feedbackId: 'fb-30', deletedAt: now, deletedByAdminId: 'a1', deleteReason: 'reason 30' }),
      createFeedback({ feedbackId: 'fb-1', deletedAt: new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000), deletedByAdminId: 'a2', deleteReason: 'reason 1' }),
      createFeedback({ feedbackId: 'fb-0', deletedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), deletedByAdminId: 'a3', deleteReason: 'reason 0' })
    ]);
    mocks.findProjectNames.mockResolvedValue([]);

    const result = await listFlaggedFeedback({ page: 1, limit: 20, deletionState: 'deleted' }, now);

    expect(mocks.listFeedback).toHaveBeenCalledWith(expect.objectContaining({ deletionState: 'deleted', skip: 0, limit: 20 }));
    expect(result.items.map(item => item.daysUntilPurge)).toEqual([30, 1, 0]);
    expect(result.items.map(item => item.isRestorable)).toEqual([true, true, false]);
    expect(result.items[0].projectName).toBeNull();
    expect(result.items[0].purgeAfter?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });
});
