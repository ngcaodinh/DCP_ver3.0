import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BeneficiaryFeedbackModel,
  countFlaggedBeneficiaryFeedback,
  findBeneficiaryFeedbackById,
  hardDeleteBeneficiaryFeedbackByIds,
  listFlaggedBeneficiaryFeedback,
  restoreBeneficiaryFeedbackById,
  transitionBeneficiaryFeedbackFlag,
  type FlaggedFeedbackQuery
} from '../../models/beneficiaryFeedbackModel';

/** Tạo query chain tối thiểu cho các truy vấn phân trang của model. */
function createListQueryChain<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(value)
  };
}

/** Tạo query chain cho findOne và findOneAndUpdate trong các helper moderation. */
function createSingleQueryChain<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(value)
  };
}

/** Tạo query chain cho các thao tác count/delete chỉ cần exec. */
function createExecQueryChain<T>(value: T) {
  return { exec: vi.fn().mockResolvedValue(value) };
}

const baseQuery: FlaggedFeedbackQuery = {
  deletionState: 'active',
  skip: 0,
  limit: 20
};

describe('beneficiaryFeedbackModel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lọc feedback moderation đang sống bằng deletedAt: null', async () => {
    const chain = createSingleQueryChain({ feedbackId: 'fb-1' });
    const findOneSpy = vi.spyOn(BeneficiaryFeedbackModel, 'findOne').mockReturnValue(chain as never);

    await findBeneficiaryFeedbackById('fb-1');

    expect(findOneSpy).toHaveBeenCalledWith({ feedbackId: 'fb-1', deletedAt: null });
    expect(chain.select).toHaveBeenCalledWith('-beneficiaryNameHash -submissionIpHash');
  });

  it('giữ deletedAt: null trong transition flag và không cho update bản ghi đã xoá', async () => {
    const updated = { toObject: () => ({ feedbackId: 'fb-1', isFlagged: true }) };
    const chain = createSingleQueryChain(updated);
    const updateSpy = vi.spyOn(BeneficiaryFeedbackModel, 'findOneAndUpdate').mockReturnValue(chain as never);

    await transitionBeneficiaryFeedbackFlag('fb-1', false, true);

    expect(updateSpy).toHaveBeenCalledWith(
      { feedbackId: 'fb-1', isFlagged: false, deletedAt: null },
      { $set: { isFlagged: true } },
      { returnDocument: 'after' }
    );
  });

  it('dùng projection allowlist và range filter cho tab đã xoá', async () => {
    const chain = createListQueryChain([]);
    const findSpy = vi.spyOn(BeneficiaryFeedbackModel, 'find').mockReturnValue(chain as never);

    await listFlaggedBeneficiaryFeedback({
      deletionState: 'deleted',
      projectId: 'project-1',
      minRiskScore: 7,
      source: 'public',
      skip: 10,
      limit: 20
    });

    expect(findSpy).toHaveBeenCalledWith({
      deletedAt: { $gt: new Date(0) },
      projectId: 'project-1',
      riskScore: { $gte: 7 },
      source: 'public'
    });
    expect(chain.select).toHaveBeenCalledWith(expect.objectContaining({ _id: 0, comment: 1, deletedAt: 1 }));
    const projection = chain.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(projection).not.toHaveProperty('beneficiaryNameHash');
    expect(projection).not.toHaveProperty('submissionIpHash');
    expect(chain.sort).toHaveBeenCalledWith({ deletedAt: 1 });
    expect(chain.skip).toHaveBeenCalledWith(10);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it('dùng sort đầy đủ riskScore rồi submittedAt cho tab active', async () => {
    const chain = createListQueryChain([]);
    const findSpy = vi.spyOn(BeneficiaryFeedbackModel, 'find').mockReturnValue(chain as never);

    await listFlaggedBeneficiaryFeedback(baseQuery);

    expect(findSpy).toHaveBeenCalledWith({ isFlagged: true, deletedAt: null });
    expect(chain.sort).toHaveBeenCalledWith({ riskScore: -1, submittedAt: -1 });
  });

  it('dùng cùng range predicate khi đếm tab đã xoá', async () => {
    const chain = createExecQueryChain(3);
    const countSpy = vi.spyOn(BeneficiaryFeedbackModel, 'countDocuments').mockReturnValue(chain as never);

    await countFlaggedBeneficiaryFeedback({ ...baseQuery, deletionState: 'deleted' });

    expect(countSpy).toHaveBeenCalledWith({ deletedAt: { $gt: new Date(0) } });
  });

  it('chỉ restore bản ghi đang flag và đã soft-delete', async () => {
    const updated = { toObject: () => ({ feedbackId: 'fb-1', isFlagged: true }) };
    const chain = createSingleQueryChain(updated);
    const updateSpy = vi.spyOn(BeneficiaryFeedbackModel, 'findOneAndUpdate').mockReturnValue(chain as never);

    await restoreBeneficiaryFeedbackById('fb-1');

    expect(updateSpy).toHaveBeenCalledWith(
      { feedbackId: 'fb-1', isFlagged: true, deletedAt: { $ne: null } },
      { $unset: { deletedAt: 1, deletedByAdminId: 1, deleteReason: 1 } },
      { returnDocument: 'after' }
    );
  });

  it('re-check cutoff trong deleteMany để không xoá nhầm record vừa restore', async () => {
    const cutoff = new Date('2026-07-16T00:00:00.000Z');
    const chain = createExecQueryChain({ deletedCount: 1 });
    const deleteSpy = vi.spyOn(BeneficiaryFeedbackModel, 'deleteMany').mockReturnValue(chain as never);

    await hardDeleteBeneficiaryFeedbackByIds(['fb-1', 'fb-2'], cutoff);

    expect(deleteSpy).toHaveBeenCalledWith({
      feedbackId: { $in: ['fb-1', 'fb-2'] },
      deletedAt: { $lte: cutoff }
    });
  });
});
