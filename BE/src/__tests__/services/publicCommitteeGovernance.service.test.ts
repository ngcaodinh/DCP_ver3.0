import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findDecisions: vi.fn(),
  findArbitrations: vi.fn(),
  findPublicEvents: vi.fn(),
  isAddress: vi.fn()
}));

vi.mock('ethers', () => ({ isAddress: mocks.isAddress }));
vi.mock('../../models/disbursementCommitteeVoteModel', () => ({
  DisbursementCommitteeVoteMongoModel: { find: mocks.findDecisions }
}));
vi.mock('../../models/projectArbitrationModel', () => ({
  ProjectArbitrationMongoModel: { find: mocks.findArbitrations }
}));
vi.mock('../../models/publicCommitteeGovernanceEventModel', () => ({
  findPublicCommitteeGovernanceEvents: mocks.findPublicEvents
}));

import { getPublicCommitteeDecisions, getPublicCommitteeGovernanceEvents } from '../../services/publicCommitteeGovernance.service';

const originalCommitteeGovernanceAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS;

describe('public committee governance read service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAddress.mockReturnValue(true);
    mocks.findArbitrations.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) });
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = '0x1111111111111111111111111111111111111111';
  });

  afterEach(() => {
    if (originalCommitteeGovernanceAddress === undefined) delete process.env.COMMITTEE_GOVERNANCE_ADDRESS;
    else process.env.COMMITTEE_GOVERNANCE_ADDRESS = originalCommitteeGovernanceAddress;
  });

  it('trả trang rỗng mà không query read model khi contract public chưa hợp lệ', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = 'not-an-address';
    mocks.isAddress.mockReturnValue(false);

    await expect(getPublicCommitteeGovernanceEvents(null, 20)).resolves.toEqual({ items: [], nextCursor: null });

    expect(mocks.findPublicEvents).not.toHaveBeenCalled();
  });

  it('chuyển đúng contract và cursor sang public event read model', async () => {
    const cursor = { blockNumber: 42, logIndex: 3 };
    mocks.findPublicEvents.mockResolvedValue({ items: [{ transactionHash: '0xtx' }], nextCursor: cursor });

    const page = await getPublicCommitteeGovernanceEvents(cursor, 8);

    expect(mocks.findPublicEvents).toHaveBeenCalledWith(process.env.COMMITTEE_GOVERNANCE_ADDRESS, cursor, 8);
    expect(page.nextCursor).toEqual(cursor);
  });

  it('chỉ công khai decision đã relay, map snapshot sang tên người bỏ phiếu và không lộ free-text nội bộ', async () => {
    const recordedAt = new Date('2026-08-29T00:00:00.000Z');
    mocks.findDecisions.mockReturnValue({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: () => ({
              exec: async () => [{
                committeeVoteId: 'vote-2', requestId: 'REQ-1', status: 'APPROVED', onChainDecisionTxHash: '0xtx', onChainDecisionRecordedAt: recordedAt,
                committeeSnapshot: [{ userId: 'chair-1', fullName: 'Chủ tịch A' }],
                votes: [
                  { voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'APPROVE', reason: 'Đủ căn cứ.', votedAt: recordedAt, signature: '0xsig', signedPayloadHash: '0xpayload', reasonCommitment: '0xreason', nonce: '7', deadline: recordedAt, committeeEpoch: '3' },
                  { voterUserId: 'former-user', voterRole: 'executive_member', decision: 'APPROVE', reason: 'Đồng ý.', votedAt: recordedAt }
                ]
              }, {
                committeeVoteId: 'vote-1', requestId: 'REQ-0', status: 'REJECTED', onChainDecisionTxHash: null, onChainDecisionRecordedAt: recordedAt,
                committeeSnapshot: [], votes: []
              }]
            })
          })
        })
      })
    });

    const page = await getPublicCommitteeDecisions(null, 1);

    expect(mocks.findDecisions).toHaveBeenCalledWith(expect.objectContaining({
      status: { $in: ['APPROVED', 'REJECTED'] }, onChainDecisionStatus: 'RECORDED'
    }));
    expect(page.items).toEqual([expect.objectContaining({
      requestId: 'REQ-1', approved: true, onChainDecisionTxHash: '0xtx',
      votes: [
        expect.objectContaining({ voterName: 'Chủ tịch A', signature: '0xsig', committeeEpoch: '3' }),
        expect.objectContaining({ voterName: 'Thành viên Ủy ban', signature: null, nonce: null, committeeEpoch: null })
      ]
    })]);
    expect(page.items[0].votes[0]).not.toHaveProperty('reason');
    expect(page.nextCursor).toEqual({ recordedAt, committeeVoteId: 'vote-2', decisionKind: 'DISBURSEMENT' });
  });

  it('khởi chạy đồng thời hai truy vấn read model độc lập', async () => {
    let resolveDisbursements: (records: never[]) => void = () => undefined;
    let resolveArbitrations: (records: never[]) => void = () => undefined;
    mocks.findDecisions.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => new Promise<never[]>(resolve => { resolveDisbursements = resolve; }) }) }) }) })
    });
    mocks.findArbitrations.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => new Promise<never[]>(resolve => { resolveArbitrations = resolve; }) }) }) }) })
    });

    const pagePromise = getPublicCommitteeDecisions(null, 20);

    expect(mocks.findDecisions).toHaveBeenCalledOnce();
    expect(mocks.findArbitrations).toHaveBeenCalledOnce();
    resolveDisbursements([]);
    resolveArbitrations([]);
    await expect(pagePromise).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('công khai lịch sử các round ký lại của xét xử nhưng không lộ free-text phiếu cũ', async () => {
    const recordedAt = new Date('2026-08-29T01:00:00.000Z');
    const emptyQuery = { select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) };
    mocks.findDecisions.mockReturnValue(emptyQuery);
    mocks.findArbitrations.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [{
        arbitrationId: 'ARB-1', verdict: 'REJECT_PROJECT', onChainDecisionTxHash: '0xarb', onChainDecisionRecordedAt: recordedAt,
        committeeSnapshot: [{ userId: 'chair-2', fullName: 'Chủ tịch mới' }],
        votes: [{ voterUserId: 'chair-2', voterRole: 'executive_chair', decision: 'REJECT_PROJECT', reason: 'Lý do nội bộ mới.', votedAt: recordedAt }],
        supersededVoteRounds: [{
          committeeSnapshot: [{ userId: 'chair-1', fullName: 'Chủ tịch cũ' }],
          votes: [{ voterUserId: 'chair-1', voterRole: 'executive_chair', decision: 'UPHOLD_PROJECT', reason: 'Lý do nội bộ cũ.', votedAt: recordedAt }],
          verdict: 'UPHOLD_PROJECT', supersededAt: recordedAt, reason: 'Epoch đã thay đổi.'
        }]
      }] }) }) }) })
    });

    const page = await getPublicCommitteeDecisions(null, 20);

    expect(page.items).toEqual([expect.objectContaining({
      requestId: 'ARB-1', decisionKind: 'ARBITRATION', approved: false,
      supersededVoteRounds: [expect.objectContaining({ verdict: 'UPHOLD_PROJECT', reason: 'Epoch đã thay đổi.' })]
    })]);
    expect(page.items[0]?.supersededVoteRounds[0]?.votes[0]).not.toHaveProperty('reason');
  });

  it('giữ seek cursor ổn định khi hai read model có cùng thời điểm và mã bản ghi', async () => {
    const recordedAt = new Date('2026-08-29T02:00:00.000Z');
    const cursor = { recordedAt, committeeVoteId: 'decision-1', decisionKind: 'DISBURSEMENT' as const };

    await getPublicCommitteeDecisions(cursor, 20);

    expect(mocks.findDecisions).toHaveBeenCalledWith(expect.objectContaining({
      $or: [
        { onChainDecisionRecordedAt: { $lt: recordedAt } },
        { onChainDecisionRecordedAt: recordedAt, committeeVoteId: { $lt: 'decision-1' } }
      ]
    }));
    expect(mocks.findArbitrations).toHaveBeenCalledWith(expect.objectContaining({
      $or: [
        { onChainDecisionRecordedAt: { $lt: recordedAt } },
        { onChainDecisionRecordedAt: recordedAt, arbitrationId: { $lt: 'decision-1' } },
        { onChainDecisionRecordedAt: recordedAt, arbitrationId: 'decision-1' }
      ]
    }));
  });

  it('không lặp quyết định giải ngân cùng khóa khi cursor đang ở arbitration có thứ tự sau', async () => {
    const recordedAt = new Date('2026-08-29T03:00:00.000Z');
    const cursor = { recordedAt, committeeVoteId: 'decision-1', decisionKind: 'ARBITRATION' as const };

    await getPublicCommitteeDecisions(cursor, 20);

    expect(mocks.findDecisions).toHaveBeenCalledWith(expect.objectContaining({
      $or: [
        { onChainDecisionRecordedAt: { $lt: recordedAt } },
        { onChainDecisionRecordedAt: recordedAt, committeeVoteId: { $lt: 'decision-1' } }
      ]
    }));
    expect(mocks.findArbitrations).toHaveBeenCalledWith(expect.objectContaining({
      $or: [
        { onChainDecisionRecordedAt: { $lt: recordedAt } },
        { onChainDecisionRecordedAt: recordedAt, arbitrationId: { $lt: 'decision-1' } }
      ]
    }));
  });

  it('giới hạn truy vấn decision ở 50 bản ghi khi client gửi limit quá lớn', async () => {
    const limit = vi.fn(() => ({ lean: () => ({ exec: async () => [] }) }));
    mocks.findDecisions.mockReturnValue({ select: () => ({ sort: () => ({ limit }) }) });

    await getPublicCommitteeDecisions(null, 500);

    expect(limit).toHaveBeenCalledWith(51);
  });
});
