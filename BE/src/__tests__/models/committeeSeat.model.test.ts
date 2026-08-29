import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  lean: vi.fn(),
  exec: vi.fn(),
  find: vi.fn(),
  countDocuments: vi.fn(),
  create: vi.fn()
}));

vi.mock('mongoose', () => {
  class MockSchema {
    constructor(_definition?: unknown, _options?: unknown) {}
    index(_fields: unknown, _options?: unknown) { return this; }
    pre(_event: unknown, _handler?: unknown) { return this; }
    post(_event: unknown, _handler?: unknown) { return this; }
  }
  return {
    default: {
      Schema: MockSchema,
      model: vi.fn(() => ({
        find: mocks.find,
        findOne: vi.fn(),
        create: mocks.create,
        countDocuments: mocks.countDocuments,
        findOneAndUpdate: mocks.findOneAndUpdate
      }))
    },
    Schema: MockSchema
  };
});

import { suspendGovernanceSeatByWalletAddress } from '../../models/authModel';

/** Tạo chain query `.lean().exec()` để kiểm tra atomic update mà không cần MongoDB. */
function configureFindOneAndUpdateResult() {
  mocks.lean.mockReturnValue({ exec: mocks.exec });
  mocks.findOneAndUpdate.mockReturnValue({ lean: mocks.lean });
}

describe('committee seat model atomic suspension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureFindOneAndUpdateResult();
    mocks.exec.mockResolvedValue({ id: 'seat-1', accountStatus: 'SUSPENDED', authVersion: 2 });
  });

  it('lọc đúng governance wallet và tăng authVersion cùng transaction update', async () => {
    const result = await suspendGovernanceSeatByWalletAddress('0xAb11111111111111111111111111111111111111');

    expect(result).toMatchObject({ accountStatus: 'SUSPENDED', authVersion: 2 });
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        governanceWalletAddress: '0xab11111111111111111111111111111111111111',
        role: { $in: ['executive_chair', 'executive_member'] },
        accountStatus: 'ACTIVE'
      },
      { $set: { accountStatus: 'SUSPENDED' }, $inc: { authVersion: 1 } },
      { returnDocument: 'after' }
    );
  });
});
