import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PublicCommitteeGovernanceEventMongoModel,
  findPublicCommitteeGovernanceEvents,
  upsertPublicCommitteeGovernanceEvent
} from '../../models/publicCommitteeGovernanceEventModel';

describe('public committee governance event read model', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upsert theo định danh chain để projector replay không tạo event trùng', async () => {
    const updateOne = vi.spyOn(PublicCommitteeGovernanceEventMongoModel, 'updateOne')
      .mockReturnValue({ exec: async () => ({ acknowledged: true }) } as never);
    const event = {
      chainId: '80002', contractAddress: '0xABC', transactionHash: '0xTX', blockNumber: 42, logIndex: 3,
      occurredAt: new Date('2026-08-29T00:00:00.000Z'), eventType: 'DECISION_RECORDED' as const, eventData: { approved: true }
    };

    await upsertPublicCommitteeGovernanceEvent(event);

    expect(updateOne).toHaveBeenCalledWith(
      { chainId: '80002', contractAddress: '0xABC', transactionHash: '0xTX', logIndex: 3 },
      { $set: event },
      { upsert: true, setDefaultsOnInsert: true }
    );
  });

  it('phân trang theo block/log giảm dần và tạo cursor từ bản ghi cuối của trang', async () => {
    const events = [
      { blockNumber: 12, logIndex: 2 },
      { blockNumber: 12, logIndex: 1 },
      { blockNumber: 11, logIndex: 9 }
    ];
    const find = vi.spyOn(PublicCommitteeGovernanceEventMongoModel, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => events }) }) })
    } as never);

    const page = await findPublicCommitteeGovernanceEvents('0xABC', { blockNumber: 12, logIndex: 3 }, 2);

    expect(find).toHaveBeenCalledWith({
      contractAddress: '0xabc',
      $or: [{ blockNumber: { $lt: 12 } }, { blockNumber: 12, logIndex: { $lt: 3 } }]
    });
    expect(page.items).toEqual(events.slice(0, 2));
    expect(page.nextCursor).toEqual({ blockNumber: 12, logIndex: 1 });
  });

  it('chuẩn hóa limit bất thường trước khi gọi Mongo', async () => {
    const find = vi.spyOn(PublicCommitteeGovernanceEventMongoModel, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) })
    } as never);

    await findPublicCommitteeGovernanceEvents('0xabc', null, Number.POSITIVE_INFINITY);

    expect(find).toHaveBeenCalledWith({ contractAddress: '0xabc' });
  });
});
