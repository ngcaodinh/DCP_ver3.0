import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkpointModel: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn()
  },
  eventModel: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn()
  },
  FakeSchema: class {
    index(): void {
      // No-op trong unit test, khong khoi tao MongoDB.
    }
  }
}));

vi.mock('mongoose', () => ({
  default: {
    model: vi.fn((modelName: string) => (
      modelName === 'SbtStatusProjectionCheckpoint'
        ? mocks.checkpointModel
        : mocks.eventModel
    ))
  },
  Schema: mocks.FakeSchema
}));

import {
  findOrCreateSbtStatusProjectionEvent,
  saveSbtStatusProjectionCheckpoint
} from '../../models/sbtStatusProjectionModel';

const scope = {
  chainId: '490000',
  contractAddress: '0x0000000000000000000000000000000000000001'
};

const event = {
  ...scope,
  transactionHash: '0xduplicate-event',
  logIndex: 0,
  blockNumber: 200,
  blockHash: '0xblock',
  tokenId: 12,
  newStatus: 'REVOKED' as const,
  reason: 'Duplicate test.'
};

/** Tao query chain gia lap cac phuong thuc lean/exec cua Mongoose. */
function createResolvedQuery(value: unknown): { lean: () => { exec: () => Promise<unknown> } } {
  return {
    lean: () => ({ exec: async () => value })
  };
}

/** Tao query chain gia tra ve loi Mongo trong exec. */
function createRejectedQuery(error: unknown): { lean: () => { exec: () => Promise<unknown> } } {
  return {
    lean: () => ({ exec: async () => Promise.reject(error) })
  };
}

describe('saveSbtStatusProjectionCheckpoint duplicate-key recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads the concurrent checkpoint after E11000 instead of failing the worker', async () => {
    const duplicateError = Object.assign(new Error('duplicate checkpoint'), { code: 11_000 });
    const concurrentCheckpoint = {
      ...scope,
      lastProcessedBlock: 201,
      lastProcessedLogIndex: Number.MAX_SAFE_INTEGER
    };
    mocks.checkpointModel.findOneAndUpdate
      .mockReturnValueOnce(createResolvedQuery(null))
      .mockReturnValueOnce(createRejectedQuery(duplicateError));
    mocks.checkpointModel.findOne
      .mockReturnValueOnce(createResolvedQuery(null))
      .mockReturnValueOnce(createResolvedQuery(concurrentCheckpoint));

    await expect(saveSbtStatusProjectionCheckpoint(scope, 200, 0)).resolves.toEqual(concurrentCheckpoint);
    expect(mocks.checkpointModel.findOne).toHaveBeenCalledTimes(2);
  });

  it('returns an already advanced checkpoint without attempting an upsert', async () => {
    const existingCheckpoint = {
      ...scope,
      lastProcessedBlock: 300,
      lastProcessedLogIndex: Number.MAX_SAFE_INTEGER
    };
    mocks.checkpointModel.findOneAndUpdate.mockReturnValueOnce(createResolvedQuery(existingCheckpoint));

    await expect(saveSbtStatusProjectionCheckpoint(scope, 200, 0)).resolves.toEqual(existingCheckpoint);
    expect(mocks.checkpointModel.findOne).not.toHaveBeenCalled();
  });

  it('rethrows E11000 when the concurrent checkpoint cannot be read back', async () => {
    const duplicateError = Object.assign(new Error('duplicate checkpoint'), { code: 11_000 });
    mocks.checkpointModel.findOneAndUpdate
      .mockReturnValueOnce(createResolvedQuery(null))
      .mockReturnValueOnce(createRejectedQuery(duplicateError));
    mocks.checkpointModel.findOne
      .mockReturnValueOnce(createResolvedQuery(null))
      .mockReturnValueOnce(createResolvedQuery(null));

    await expect(saveSbtStatusProjectionCheckpoint(scope, 200, 0)).rejects.toBe(duplicateError);
  });

  it('rethrows non-duplicate checkpoint persistence errors without a read-back', async () => {
    const persistenceError = new Error('Mongo unavailable');
    mocks.checkpointModel.findOneAndUpdate
      .mockReturnValueOnce(createResolvedQuery(null))
      .mockReturnValueOnce(createRejectedQuery(persistenceError));
    mocks.checkpointModel.findOne.mockReturnValueOnce(createResolvedQuery(null));

    await expect(saveSbtStatusProjectionCheckpoint(scope, 200, 0)).rejects.toBe(persistenceError);
    expect(mocks.checkpointModel.findOne).toHaveBeenCalledTimes(1);
  });

  it('reads the concurrent event after E11000 instead of creating a duplicate identity', async () => {
    const duplicateError = Object.assign(new Error('duplicate event'), { code: 11_000 });
    const concurrentEvent = { ...event, projectionStatus: 'PENDING' as const };
    mocks.eventModel.findOneAndUpdate.mockReturnValueOnce(createRejectedQuery(duplicateError));
    mocks.eventModel.findOne.mockReturnValueOnce(createResolvedQuery(concurrentEvent));

    await expect(findOrCreateSbtStatusProjectionEvent(event)).resolves.toEqual(concurrentEvent);
  });

  it('rethrows E11000 when the concurrent event cannot be read back', async () => {
    const duplicateError = Object.assign(new Error('duplicate event'), { code: 11_000 });
    mocks.eventModel.findOneAndUpdate.mockReturnValueOnce(createRejectedQuery(duplicateError));
    mocks.eventModel.findOne.mockReturnValueOnce(createResolvedQuery(null));

    await expect(findOrCreateSbtStatusProjectionEvent(event)).rejects.toBe(duplicateError);
  });

  it('rethrows non-duplicate event persistence errors without a read-back', async () => {
    const persistenceError = new Error('Mongo unavailable');
    mocks.eventModel.findOneAndUpdate.mockReturnValueOnce(createRejectedQuery(persistenceError));

    await expect(findOrCreateSbtStatusProjectionEvent(event)).rejects.toBe(persistenceError);
    expect(mocks.eventModel.findOne).not.toHaveBeenCalled();
  });
});
