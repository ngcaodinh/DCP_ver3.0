import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addVoteToOverrideRequest,
  type OracleOverrideRequestRecord
} from '../../models/oracleOverrideRequestModel';

const createQuery = (value: unknown) => ({
  lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(value) }))
});

const baseRequest = {
  overrideRequestId: 'override-1',
  status: 'PENDING',
  votes: []
} as unknown as OracleOverrideRequestRecord;

describe('oracleOverrideRequestModel.addVoteToOverrideRequest', () => {
  const model = mongoose.models.OracleOverrideRequest as unknown as {
    findOneAndUpdate: typeof vi.fn;
    findOne: typeof vi.fn;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('giữ atomic filter chống duplicate và trả document sau update', async () => {
    const updated = { ...baseRequest, votes: [{ commissionerId: 'commissioner-1' }] };
    const updateSpy = vi.spyOn(model, 'findOneAndUpdate').mockReturnValue(createQuery(updated) as never);

    const result = await addVoteToOverrideRequest(
      'override-1',
      {
        commissionerId: 'commissioner-1',
        commissionerRole: 'admin',
        vote: 'APPROVE',
        reason: 'verified',
        votedAt: new Date()
      }
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideRequestId: 'override-1',
        status: 'PENDING',
        'votes.commissionerId': { $ne: 'commissioner-1' }
      }),
      expect.objectContaining({ $push: expect.anything() }),
      expect.objectContaining({ returnDocument: 'after' })
    );
    expect(result).toEqual({ result: 'OK', document: updated });
  });

  it('phân biệt duplicate vote khi atomic update không match', async () => {
    const updated = { ...baseRequest, votes: [{ commissionerId: 'commissioner-1' }] };
    const updateSpy = vi.spyOn(model, 'findOneAndUpdate')
      .mockReturnValueOnce(createQuery(updated) as never)
      .mockReturnValueOnce(createQuery(null) as never);
    const findSpy = vi.spyOn(model, 'findOne').mockReturnValue(createQuery(baseRequest) as never);

    const firstResult = await addVoteToOverrideRequest(
      'override-1',
      {
        commissionerId: 'commissioner-1',
        commissionerRole: 'admin',
        vote: 'APPROVE',
        reason: 'duplicate',
        votedAt: new Date()
      }
    );
    const secondResult = await addVoteToOverrideRequest(
      'override-1',
      {
        commissionerId: 'commissioner-1',
        commissionerRole: 'admin',
        vote: 'APPROVE',
        reason: 'duplicate',
        votedAt: new Date()
      }
    );

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(findSpy).toHaveBeenCalledWith({ overrideRequestId: 'override-1' });
    expect(firstResult).toEqual({ result: 'OK', document: updated });
    expect(secondResult).toEqual({ result: 'ALREADY_VOTED', document: null });
  });
});
