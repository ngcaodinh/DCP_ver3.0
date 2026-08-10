import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFind,
  mockSort,
  mockLimit,
  mockSelect,
  mockFindExec,
  mockAggregate,
  mockAggregateExec
} = vi.hoisted(() => {
  const mockFindExec = vi.fn();
  const mockLean = vi.fn(() => ({ exec: mockFindExec }));
  const mockSelect = vi.fn(() => ({ lean: mockLean }));
  const mockLimit = vi.fn(() => ({ select: mockSelect }));
  const mockSort = vi.fn(() => ({ limit: mockLimit }));
  const mockFind = vi.fn(() => ({ sort: mockSort }));
  const mockAggregateExec = vi.fn();
  const mockAggregate = vi.fn(() => ({ exec: mockAggregateExec }));

  return {
    mockFind,
    mockSort,
    mockLimit,
    mockSelect,
    mockFindExec,
    mockAggregate,
    mockAggregateExec
  };
});

vi.mock('mongoose', () => {
  class MockSchema {
    index(): this {
      return this;
    }
  }

  const model = vi.fn(() => ({
    find: mockFind,
    aggregate: mockAggregate
  }));

  return {
    Schema: MockSchema,
    model,
    default: { Schema: MockSchema, model }
  };
});

import {
  getCompletedDisbursementSummaryByProjectId,
  findCompletedDisbursementAmountsByProjectId,
  MAX_COMPLETED_DISBURSEMENT_AMOUNTS
} from '../../models/disbursementModel';

describe('disbursementModel verification query helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindExec.mockResolvedValue([]);
    mockAggregateExec.mockResolvedValue([]);
  });

  it('lọc COMPLETED ngay trong aggregation và chỉ group amount/count', async () => {
    await getCompletedDisbursementSummaryByProjectId('project-aggregate');

    const pipeline = ((mockAggregate.mock.calls as unknown[][])[0]?.[0] ?? []) as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: { projectId: 'project-aggregate', status: 'COMPLETED' }
    });
    expect(pipeline[1]).toEqual({
      $group: {
        _id: null,
        totalCompletedAmount: { $sum: '$amount' },
        completedCount: { $sum: 1 }
      }
    });
  });

  it('chỉ lấy amount của tối đa 100 khoản COMPLETED gần nhất', async () => {
    mockFindExec.mockResolvedValue([{ amount: 700 }, { amount: 300 }]);

    const result = await findCompletedDisbursementAmountsByProjectId('project-amounts', 999);

    expect(mockFind).toHaveBeenCalledWith({ projectId: 'project-amounts', status: 'COMPLETED' });
    expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(mockLimit).toHaveBeenCalledWith(MAX_COMPLETED_DISBURSEMENT_AMOUNTS);
    expect(mockSelect).toHaveBeenCalledWith('amount');
    expect(result).toEqual([700, 300]);
  });
});
