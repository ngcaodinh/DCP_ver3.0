import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditorFieldReportMongoModel, findAuditorFieldReportsByProjectIds } from '../../models/auditorFieldReportModel';

describe('auditor field report batch query', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('không truy vấn database khi danh sách project chỉ có giá trị rỗng', async () => {
    const aggregate = vi.spyOn(AuditorFieldReportMongoModel, 'aggregate');

    await expect(findAuditorFieldReportsByProjectIds([' ', '', '  '])).resolves.toEqual([]);

    expect(aggregate).not.toHaveBeenCalled();
  });

  it('loại trùng projectId, chuẩn hóa limit và dùng pipeline giới hạn theo từng project', async () => {
    const aggregate = vi.spyOn(AuditorFieldReportMongoModel, 'aggregate')
      .mockReturnValue({ exec: async () => [] } as never);

    await findAuditorFieldReportsByProjectIds([' project-1 ', 'project-1', 'project-2'], 200);

    expect(aggregate).toHaveBeenCalledWith([
      { $match: { projectId: { $in: ['project-1', 'project-2'] } } },
      { $sort: { projectId: 1, submittedAt: -1, reportId: -1 } },
      { $group: { _id: '$projectId', items: { $push: '$$ROOT' } } },
      { $project: { items: { $slice: ['$items', 50] } } },
      { $unwind: '$items' },
      { $replaceRoot: { newRoot: '$items' } }
    ]);
  });

  it('tôn trọng limit tối thiểu một report cho mỗi project', async () => {
    const aggregate = vi.spyOn(AuditorFieldReportMongoModel, 'aggregate')
      .mockReturnValue({ exec: async () => [] } as never);

    await findAuditorFieldReportsByProjectIds(['project-1'], 0);

    expect(JSON.stringify(aggregate.mock.calls[0][0])).toContain('$slice');
    expect(JSON.stringify(aggregate.mock.calls[0][0])).toContain('1');
  });
});
