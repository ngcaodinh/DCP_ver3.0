import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPurge: vi.fn(),
  hardDelete: vi.fn(),
  invalidate: vi.fn()
}));

vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  findSoftDeletedFeedbackForPurge: mocks.findPurge,
  hardDeleteBeneficiaryFeedbackByIds: mocks.hardDelete
}));
vi.mock('../../services/publicFeedback.service', () => ({ invalidatePublicFeedbackStatsCache: mocks.invalidate }));

import { purgeSoftDeletedFeedback } from '../../services/feedbackPurge.service';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-08-15T00:00:00.000Z');

function record(feedbackId: string, deletedAt: Date, projectId = 'project-1') {
  return { feedbackId, projectId, deletedAt };
}

describe('feedbackPurge.service', () => {
  beforeEach(() => {
    mocks.findPurge.mockReset();
    mocks.hardDelete.mockReset();
    mocks.invalidate.mockReset();
  });

  it('chỉ purge record quá 30 ngày, không đụng record 29 ngày và invalidate project theo lô', async () => {
    const records = [
      record('old', new Date(now.getTime() - 31 * DAY), 'project-old'),
      record('recent', new Date(now.getTime() - 29 * DAY), 'project-recent')
    ];
    mocks.findPurge.mockImplementation(async (cutoff: Date) => records.filter(item => item.deletedAt <= cutoff));
    mocks.hardDelete.mockImplementation(async (ids: string[]) => {
      const deletedIds = new Set(ids);
      const before = records.length;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (deletedIds.has(records[index].feedbackId)) records.splice(index, 1);
      }
      return before - records.length;
    });

    const result = await purgeSoftDeletedFeedback({ now, batchSize: 10 });

    expect(result.cutoff.toISOString()).toBe('2026-07-16T00:00:00.000Z');
    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(records.map(item => item.feedbackId)).toEqual(['recent']);
    expect(mocks.invalidate).toHaveBeenCalledWith('project-old');
  });

  it('tôn trọng batchSize/maxBatches và báo hasMore khi còn backlog', async () => {
    mocks.findPurge
      .mockResolvedValueOnce([record('fb-1', new Date(now.getTime() - 31 * DAY)), record('fb-2', new Date(now.getTime() - 32 * DAY))])
      .mockResolvedValueOnce([record('fb-3', new Date(now.getTime() - 33 * DAY))]);
    mocks.hardDelete.mockResolvedValue(2);

    const result = await purgeSoftDeletedFeedback({ now, batchSize: 2, maxBatches: 1 });

    expect(mocks.findPurge).toHaveBeenCalledTimes(1);
    expect(mocks.hardDelete).toHaveBeenCalledWith(['fb-1', 'fb-2'], result.cutoff);
    expect(result.hasMore).toBe(true);
  });

  it('truyền cutoff vào hard delete để model re-check trạng thái hiện tại', async () => {
    const selected = [record('restored-during-purge', new Date(now.getTime() - 31 * DAY))];
    mocks.findPurge.mockResolvedValueOnce(selected);
    mocks.hardDelete.mockResolvedValueOnce(0);

    const result = await purgeSoftDeletedFeedback({ now, batchSize: 10 });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(0);
    expect(mocks.hardDelete).toHaveBeenCalledWith(['restored-during-purge'], result.cutoff);
  });
});
