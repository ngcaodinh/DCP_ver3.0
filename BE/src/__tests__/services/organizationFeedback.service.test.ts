import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  find: vi.fn(),
  findProjectNamesByProjectIdList: vi.fn()
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: {
    aggregate: mocks.aggregate,
    find: mocks.find
  }
}));

vi.mock('../../models/projectModel', () => ({
  findProjectNamesByProjectIdList: mocks.findProjectNamesByProjectIdList
}));

import { listOrganizationFeedback } from '../../services/organizationFeedback.service';

function createFindQuery(items: unknown[] = []): Record<string, ReturnType<typeof vi.fn>> {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn().mockReturnValue(query);
  query.sort = vi.fn().mockReturnValue(query);
  query.skip = vi.fn().mockReturnValue(query);
  query.limit = vi.fn().mockReturnValue(query);
  query.lean = vi.fn().mockReturnValue(query);
  query.exec = vi.fn().mockResolvedValue(items);
  return query;
}

describe('organizationFeedback.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findProjectNamesByProjectIdList.mockResolvedValue([
      { projectId: 'DA-001', name: 'Dự án một' }
    ]);
  });

  it('dùng cùng predicate sở hữu và deletedAt cho list lẫn aggregate, đồng thời loại field nội bộ khỏi DTO', async () => {
    mocks.aggregate.mockResolvedValue([{
      totalCount: 2,
      visibleCount: 1,
      pendingCount: 1,
      avgRating: 4.326666666666667,
      rating1: 0,
      rating2: 0,
      rating3: 0,
      rating4: 1,
      rating5: 1
    }]);
    const findQuery = createFindQuery([{
      feedbackId: 'FB-1',
      projectId: 'DA-001',
      rating: 5,
      comment: 'Đã nhận hỗ trợ',
      submittedAt: new Date('2026-08-10T00:00:00Z'),
      source: 'batch',
      isFlagged: false,
      riskScore: 9,
      beneficiaryNameHash: 'private'
    }]);
    mocks.find.mockReturnValue(findQuery);

    const result = await listOrganizationFeedback({
      page: 1,
      limit: 20,
      moderationState: 'all'
    }, 'org-1');

    const aggregateMatch = mocks.aggregate.mock.calls[0][0][0].$match;
    expect(aggregateMatch).toEqual({ uploadedByOrganizationId: 'org-1', deletedAt: null });
    expect(mocks.find).toHaveBeenCalledWith(aggregateMatch);
    expect(findQuery.select).toHaveBeenCalledWith(expect.objectContaining({
      _id: 0,
      feedbackId: 1,
      isFlagged: 1
    }));
    expect(findQuery.sort).toHaveBeenCalledWith({ submittedAt: -1, feedbackId: -1 });
    expect(result.total).toBe(2);
    expect(result.stats).toEqual(expect.objectContaining({ totalCount: 2, visibleCount: 1, pendingCount: 1, avgRating: 4.33 }));
    expect(result.items[0]).not.toHaveProperty('riskScore');
    expect(result.items[0]).not.toHaveProperty('beneficiaryNameHash');
  });

  it('áp dụng project, source và pending vào cả hai truy vấn, rồi chuẩn hóa deep-link về trang cuối', async () => {
    mocks.aggregate.mockResolvedValue([{
      totalCount: 3,
      visibleCount: 0,
      pendingCount: 3,
      avgRating: 3,
      rating3: 3
    }]);
    const findQuery = createFindQuery([]);
    mocks.find.mockReturnValue(findQuery);

    const result = await listOrganizationFeedback({
      page: 999,
      limit: 2,
      projectId: 'DA-001',
      source: 'public',
      moderationState: 'pending'
    }, 'org-1');

    const expectedPredicate = {
      uploadedByOrganizationId: 'org-1',
      deletedAt: null,
      projectId: 'DA-001',
      source: 'public',
      isFlagged: true
    };
    expect(mocks.aggregate.mock.calls[0][0][0].$match).toEqual(expectedPredicate);
    expect(mocks.find).toHaveBeenCalledWith(expectedPredicate);
    expect(findQuery.skip).toHaveBeenCalledWith(2);
    expect(findQuery.limit).toHaveBeenCalledWith(2);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
  });

  it('lọc moderationState visible bằng isFlagged false', async () => {
    mocks.aggregate.mockResolvedValueOnce([{
      totalCount: 1,
      visibleCount: 1,
      pendingCount: 0,
      avgRating: 5,
      rating5: 1
    }]);
    const findQuery = createFindQuery([]);
    mocks.find.mockReturnValue(findQuery);

    await listOrganizationFeedback({
      page: 1,
      limit: 20,
      moderationState: 'visible'
    }, 'org-1');

    const expectedPredicate = {
      uploadedByOrganizationId: 'org-1',
      deletedAt: null,
      isFlagged: false
    };
    expect(mocks.aggregate.mock.calls[0][0][0].$match).toEqual(expectedPredicate);
    expect(mocks.find).toHaveBeenCalledWith(expectedPredicate);
  });

  it('trả stats rỗng an toàn và không phát hành projectName khi không có bản ghi', async () => {
    mocks.aggregate.mockResolvedValue([]);
    mocks.find.mockReturnValue(createFindQuery([]));

    const result = await listOrganizationFeedback({ page: 1, limit: 20, moderationState: 'all' }, 'org-empty');

    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.stats).toEqual({
      totalCount: 0,
      visibleCount: 0,
      pendingCount: 0,
      avgRating: null,
      distribution: {}
    });
    expect(result.items).toEqual([]);
    expect(mocks.findProjectNamesByProjectIdList).toHaveBeenCalledWith([]);
  });

  it('dừng và không query danh sách khi aggregate gặp lỗi', async () => {
    mocks.aggregate.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(listOrganizationFeedback({ page: 1, limit: 20, moderationState: 'all' }, 'org-1'))
      .rejects.toThrow('database unavailable');

    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.findProjectNamesByProjectIdList).not.toHaveBeenCalled();
  });

  it('batch lookup project name một lần với danh sách projectId duy nhất', async () => {
    mocks.aggregate.mockResolvedValueOnce([{
      totalCount: 3,
      visibleCount: 3,
      pendingCount: 0,
      avgRating: 4,
      rating4: 3
    }]);
    const findQuery = createFindQuery([
      { feedbackId: 'FB-1', projectId: 'DA-001', rating: 4, comment: 'A', submittedAt: new Date('2026-01-01T00:00:00Z'), source: 'batch', isFlagged: false },
      { feedbackId: 'FB-2', projectId: 'DA-002', rating: 4, comment: 'B', submittedAt: new Date('2026-01-01T00:00:00Z'), source: 'public', isFlagged: false },
      { feedbackId: 'FB-3', projectId: 'DA-001', rating: 4, comment: 'C', submittedAt: new Date('2026-01-01T00:00:00Z'), source: 'batch', isFlagged: false }
    ]);
    mocks.find.mockReturnValue(findQuery);

    await listOrganizationFeedback({ page: 1, limit: 20, moderationState: 'all' }, 'org-1');

    expect(mocks.findProjectNamesByProjectIdList).toHaveBeenCalledTimes(1);
    expect(mocks.findProjectNamesByProjectIdList).toHaveBeenCalledWith(['DA-001', 'DA-002']);
  });
});
