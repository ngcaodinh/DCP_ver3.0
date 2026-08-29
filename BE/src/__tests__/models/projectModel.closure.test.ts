import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectMongoModel, claimProjectForActivation, claimProjectForClosure, findRejectedProjectsNeedingClosure } from '../../models/projectModel';

describe('project closure persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chỉ lấy dự án REJECTED có closure retry đến hạn trong batch worker', async () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const find = vi.spyOn(ProjectMongoModel, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) })
    } as never);

    await expect(findRejectedProjectsNeedingClosure(now, 50)).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith({
      status: 'REJECTED',
      closureState: { $in: ['PENDING', 'FAILED'] },
      $or: [{ closureNextAttemptAt: null }, { closureNextAttemptAt: { $lte: now } }]
    });
  });

  it('claim đóng dự án dùng CAS theo REJECTED, trạng thái closure và lease cũ', async () => {
    const staleClaimCutoff = new Date('2026-08-29T00:00:00.000Z');
    const findOneAndUpdate = vi.spyOn(ProjectMongoModel, 'findOneAndUpdate').mockReturnValue({
      lean: () => ({ exec: async () => null })
    } as never);

    await expect(claimProjectForClosure('project-1', staleClaimCutoff)).resolves.toBeNull();

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        status: 'REJECTED',
        closureState: { $in: ['PENDING', 'FAILED'] },
        $or: [{ closureClaimedAt: null }, { closureClaimedAt: { $lt: staleClaimCutoff } }]
      },
      { $set: { closureClaimedAt: expect.any(Date) } },
      { returnDocument: 'after' }
    );
  });

  it('không claim kích hoạt lại dự án REJECTED khi quy trình đóng on-chain đã bắt đầu', async () => {
    const staleClaimCutoff = new Date('2026-08-29T00:00:00.000Z');
    const findOneAndUpdate = vi.spyOn(ProjectMongoModel, 'findOneAndUpdate').mockReturnValue({
      exec: async () => null
    } as never);

    await expect(claimProjectForActivation('project-1', 'REJECTED', staleClaimCutoff)).resolves.toBeNull();

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        status: 'REJECTED',
        closureState: { $in: [null, 'NOT_REQUIRED'] },
        $or: [{ activationClaimedAt: null }, { activationClaimedAt: { $lt: staleClaimCutoff } }]
      },
      { $set: { activationClaimedAt: expect.any(Date) } },
      { returnDocument: 'after' }
    );
  });
});
