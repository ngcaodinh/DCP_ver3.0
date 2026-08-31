import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditorListingVerificationMongoModel,
  countListingVerificationsByProjectRounds
} from '../../models/auditorListingVerificationModel';

describe('auditor listing verification summary query', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('không query khi không có cặp project/vòng hợp lệ', async () => {
    const aggregate = vi.spyOn(AuditorListingVerificationMongoModel, 'aggregate');

    await expect(countListingVerificationsByProjectRounds([{ projectId: ' ', round: 0 }])).resolves.toEqual([]);

    expect(aggregate).not.toHaveBeenCalled();
  });

  it('gom count theo đúng cặp project/vòng, loại cặp lặp lại', async () => {
    const aggregate = vi.spyOn(AuditorListingVerificationMongoModel, 'aggregate')
      .mockReturnValue({ exec: async () => [{ _id: { projectId: 'project-1', round: 2 }, count: 3 }] } as never);

    await expect(countListingVerificationsByProjectRounds([
      { projectId: ' project-1 ', round: 2 },
      { projectId: 'project-1', round: 2 }
    ])).resolves.toEqual([{ projectId: 'project-1', round: 2, count: 3 }]);

    expect(aggregate).toHaveBeenCalledWith([
      { $match: { $or: [{ projectId: 'project-1', round: 2 }] } },
      { $group: { _id: { projectId: '$projectId', round: '$round' }, count: { $sum: 1 } } }
    ]);
  });
});
