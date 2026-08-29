import { describe, expect, it, vi } from 'vitest';
import {
  CommitteeVoteSigningRequestMongoModel,
  consumeCommitteeVoteSigningRequest
} from '../../models/committeeVoteSigningRequestModel';

describe('committee vote signing request indexes', () => {
  it('có TTL theo deadline để signing request chưa dùng không tích lũy vĩnh viễn', () => {
    expect(CommitteeVoteSigningRequestMongoModel.schema.indexes()).toContainEqual([
      { deadline: 1 },
      { expireAfterSeconds: 0 }
    ]);
  });

  it('consume bằng CAS chỉ cho signing request chưa dùng và còn hạn', async () => {
    const updateOne = vi.spyOn(CommitteeVoteSigningRequestMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) } as never);

    await expect(consumeCommitteeVoteSigningRequest('request-1')).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      { signingRequestId: 'request-1', consumedAt: null, deadline: { $gt: expect.any(Date) } },
      { $set: { consumedAt: expect.any(Date) } }
    );
  });

  it('trả false khi request đã bị consume hoặc hết hạn nên vote không thể replay', async () => {
    vi.spyOn(CommitteeVoteSigningRequestMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);

    await expect(consumeCommitteeVoteSigningRequest('expired-request')).resolves.toBe(false);
  });
});
