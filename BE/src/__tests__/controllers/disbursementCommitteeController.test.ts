import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractAuditRequestContext: vi.fn(),
  recoverExecution: vi.fn(),
  recordAdminAuditLog: vi.fn(),
  sendErrorFromUnknown: vi.fn(),
  sendErrorResponse: vi.fn(),
  sendSuccessResponse: vi.fn()
}));

vi.mock('../../services/disbursementCommitteeVoting.service', () => ({
  getPendingDisbursementCommitteeCases: vi.fn(),
  prepareDisbursementVoteSignature: vi.fn(),
  recoverDeadLetterDisbursementCommitteeExecution: mocks.recoverExecution,
  voteOnDisbursement: vi.fn()
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAdminAuditLog }));
vi.mock('../../utils/auditRequestContext', () => ({ extractAuditRequestContext: mocks.extractAuditRequestContext }));
vi.mock('../../utils/apiResponse', () => ({
  sendErrorFromUnknown: mocks.sendErrorFromUnknown,
  sendErrorResponse: mocks.sendErrorResponse,
  sendSuccessResponse: mocks.sendSuccessResponse
}));

import { handleRecoverDeadLetterDisbursementExecution } from '../../controllers/disbursementCommitteeController';

describe('handleRecoverDeadLetterDisbursementExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractAuditRequestContext.mockReturnValue({ ipAddress: '127.0.0.1' });
    mocks.recoverExecution.mockResolvedValue(undefined);
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);
  });

  it('từ chối request chưa xác thực trước khi gọi recovery service', async () => {
    await handleRecoverDeadLetterDisbursementExecution({ params: { requestId: 'REQ-1' }, body: { reason: 'Đã đối soát nguyên nhân và yêu cầu chạy lại an toàn.' } } as never, {} as Response);

    expect(mocks.sendErrorResponse).toHaveBeenCalledWith(expect.anything(), 401, expect.any(String), 'UNAUTHENTICATED');
    expect(mocks.recoverExecution).not.toHaveBeenCalled();
  });

  it('từ chối lý do recovery ngắn hoặc requestId không hợp lệ trước khi tạo side effect', async () => {
    await handleRecoverDeadLetterDisbursementExecution({
      authenticatedUser: { userId: 'admin-1', role: 'admin' }, params: { requestId: ' ' }, body: { reason: 'quá ngắn' }
    } as never, {} as Response);

    expect(mocks.sendErrorResponse).toHaveBeenCalledWith(expect.anything(), 400, expect.any(String), 'VALIDATION_ERROR');
    expect(mocks.recoverExecution).not.toHaveBeenCalled();
    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
  });

  it('khôi phục case DLQ, ghi audit có lý do và trả requestId đã xử lý', async () => {
    const request = {
      authenticatedUser: { userId: 'admin-1', role: 'admin' },
      params: { requestId: 'REQ-DLQ' },
      body: { reason: 'Đã đối soát RPC và contract, cho phép chạy lại worker an toàn.' }
    } as never;

    await handleRecoverDeadLetterDisbursementExecution(request, {} as Response);

    expect(mocks.recoverExecution).toHaveBeenCalledWith('REQ-DLQ', 'EXECUTION');
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 'admin-1', actionType: 'DISBURSEMENT_COMMITTEE_EXECUTION_RECOVERED',
      targetId: 'REQ-DLQ', targetType: 'DISBURSEMENT_REQUEST', context: { requestId: 'REQ-DLQ', executionStatus: 'PENDING' }
    }));
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(expect.anything(), 200, expect.any(String), { requestId: 'REQ-DLQ', scope: 'EXECUTION' });
  });

  it('khôi phục DLQ relay khi admin chọn scope quyết định on-chain', async () => {
    await handleRecoverDeadLetterDisbursementExecution({
      authenticatedUser: { userId: 'admin-1', role: 'admin' }, params: { requestId: 'REQ-RELAY-DLQ' },
      body: { scope: 'ON_CHAIN_DECISION', reason: 'Đã đối soát RPC và contract trước khi đưa relay vào hàng đợi lại.' }
    } as never, {} as Response);

    expect(mocks.recoverExecution).toHaveBeenCalledWith('REQ-RELAY-DLQ', 'ON_CHAIN_DECISION');
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'DISBURSEMENT_COMMITTEE_ON_CHAIN_DECISION_RECOVERED',
      context: { requestId: 'REQ-RELAY-DLQ', scope: 'ON_CHAIN_DECISION', onChainDecisionStatus: 'PENDING' }
    }));
  });

  it('không ghi audit thành công khi recovery service từ chối state transition', async () => {
    const failure = new Error('case is not dead letter');
    mocks.recoverExecution.mockRejectedValue(failure);

    await handleRecoverDeadLetterDisbursementExecution({
      authenticatedUser: { userId: 'admin-1', role: 'admin' }, params: { requestId: 'REQ-OPEN' },
      body: { reason: 'Đã kiểm tra đầy đủ nhưng hồ sơ vẫn không hợp lệ để khôi phục.' }
    } as never, {} as Response);

    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(expect.anything(), failure, expect.any(String));
  });
});
