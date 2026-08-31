import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditorFieldReportMongoModel,
  countAuditorFieldReportsByProjectIds,
  findAuditorFieldReportGeofenceMetadataByProjectIds,
  findAuditorFieldReportsByProjectIds
} from '../../models/auditorFieldReportModel';

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

  it('đếm report bằng aggregate và trả Map theo projectId cho card ACTIVE', async () => {
    const aggregate = vi.spyOn(AuditorFieldReportMongoModel, 'aggregate')
      .mockReturnValue({ exec: async () => [{ _id: 'project-1', count: 2 }] } as never);

    await expect(countAuditorFieldReportsByProjectIds([' project-1 ', 'project-1'])).resolves.toEqual(new Map([['project-1', 2]]));

    expect(aggregate).toHaveBeenCalledWith([
      { $match: { projectId: { $in: ['project-1'] } } },
      { $group: { _id: '$projectId', count: { $sum: 1 } } }
    ]);
  });

  it('chỉ projection metadata GPS cần thiết khi tính mức lệch card ACTIVE', async () => {
    const find = vi.spyOn(AuditorFieldReportMongoModel, 'find')
      .mockReturnValue({ lean: () => ({ exec: async () => [] }) } as never);

    await findAuditorFieldReportGeofenceMetadataByProjectIds(['project-1']);

    expect(find).toHaveBeenCalledWith(
      { projectId: { $in: ['project-1'] } },
      expect.objectContaining({ _id: 0, projectId: 1, 'photos.gps': 1, 'photos.accuracyMeters': 1 })
    );
  });
});
