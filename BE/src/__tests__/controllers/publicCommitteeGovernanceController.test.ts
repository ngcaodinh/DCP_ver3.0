import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDecisions: vi.fn(),
  getEvents: vi.fn(),
  sendErrorFromUnknown: vi.fn(),
  sendSuccessResponse: vi.fn()
}));

vi.mock('../../services/publicCommitteeGovernance.service', () => ({
  getPublicCommitteeDecisions: mocks.getDecisions,
  getPublicCommitteeGovernanceEvents: mocks.getEvents
}));
vi.mock('../../utils/apiResponse', () => ({
  sendErrorFromUnknown: mocks.sendErrorFromUnknown,
  sendSuccessResponse: mocks.sendSuccessResponse
}));

import {
  handleGetPublicCommitteeDecisions,
  handleGetPublicCommitteeGovernanceEvents
} from '../../controllers/publicCommitteeGovernanceController';

describe('public committee governance controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('giải mã event cursor hợp lệ, giữ limit hợp lệ và mã hóa next cursor trả về', async () => {
    const cursor = { blockNumber: 42, logIndex: 3 };
    mocks.getEvents.mockResolvedValue({ items: [{ eventType: 'DECISION_RECORDED' }], nextCursor: cursor });
    const request = { query: { cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'), limit: '8' } } as unknown as Request;

    await handleGetPublicCommitteeGovernanceEvents(request, {} as Response);

    expect(mocks.getEvents).toHaveBeenCalledWith(cursor, 8);
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(
      expect.anything(), 200, expect.any(String),
      { items: [{ eventType: 'DECISION_RECORDED' }], nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }
    );
  });

  it('bỏ cursor event hỏng và trả limit mặc định thay vì truyền filter không tin cậy xuống service', async () => {
    mocks.getEvents.mockResolvedValue({ items: [], nextCursor: null });
    const request = { query: { cursor: 'not-base64', limit: '999' } } as unknown as Request;

    await handleGetPublicCommitteeGovernanceEvents(request, {} as Response);

    expect(mocks.getEvents).toHaveBeenCalledWith(null, 20);
  });

  it('giải mã cursor decision theo ISO date và serial hóa date trước khi trả client', async () => {
    const recordedAt = new Date('2026-08-29T00:00:00.000Z');
    const cursor = { recordedAt: recordedAt.toISOString(), committeeVoteId: 'vote-1' };
    mocks.getDecisions.mockResolvedValue({ items: [], nextCursor: { recordedAt, committeeVoteId: 'vote-0', decisionKind: 'ARBITRATION' } });
    const request = { query: { cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'), limit: '5' } } as unknown as Request;

    await handleGetPublicCommitteeDecisions(request, {} as Response);

    expect(mocks.getDecisions).toHaveBeenCalledWith({ recordedAt, committeeVoteId: 'vote-1', decisionKind: 'DISBURSEMENT' }, 5);
    const responsePayload = mocks.sendSuccessResponse.mock.calls[0][3] as { nextCursor: string };
    expect(JSON.parse(Buffer.from(responsePayload.nextCursor, 'base64url').toString('utf8'))).toEqual({ recordedAt: recordedAt.toISOString(), committeeVoteId: 'vote-0', decisionKind: 'ARBITRATION' });
  });

  it('chuẩn hóa lỗi service theo response envelope hiện có', async () => {
    const failure = new Error('read model unavailable');
    mocks.getDecisions.mockRejectedValue(failure);

    await handleGetPublicCommitteeDecisions({ query: {} } as Request, {} as Response);

    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(expect.anything(), failure, expect.any(String));
  });
});
