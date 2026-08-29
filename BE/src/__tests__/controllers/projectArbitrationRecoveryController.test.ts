import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractAuditRequestContext: vi.fn(),
  recoverOnChainDecision: vi.fn(),
  recordAdminAuditLog: vi.fn(),
  runMongoTransaction: vi.fn(),
  sendErrorFromUnknown: vi.fn(),
  sendErrorResponse: vi.fn(),
  sendSuccessResponse: vi.fn()
}));

vi.mock('../../services/projectArbitration.service', () => ({
  prepareArbitrationVoteSignature: vi.fn(),
  recoverDeadLetterProjectArbitrationOnChainDecision: mocks.recoverOnChainDecision,
  voteOnArbitration: vi.fn()
}));
vi.mock('../../services/audit-log.service', () => ({ recordAdminAuditLog: mocks.recordAdminAuditLog }));
vi.mock('../../utils/auditRequestContext', () => ({ extractAuditRequestContext: mocks.extractAuditRequestContext }));
vi.mock('../../utils/mongoTransaction', () => ({ runMongoTransaction: mocks.runMongoTransaction }));
vi.mock('../../utils/apiResponse', () => ({
  sendErrorFromUnknown: mocks.sendErrorFromUnknown,
  sendErrorResponse: mocks.sendErrorResponse,
  sendSuccessResponse: mocks.sendSuccessResponse
}));

import { handleRecoverProjectArbitrationOnChainDecision } from '../../controllers/projectGovernanceController';

describe('handleRecoverProjectArbitrationOnChainDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractAuditRequestContext.mockReturnValue({ ipAddress: '127.0.0.1', userAgent: 'vitest' });
    mocks.recoverOnChainDecision.mockResolvedValue(undefined);
    mocks.recordAdminAuditLog.mockResolvedValue(undefined);
    mocks.runMongoTransaction.mockImplementation(
      async (work: (session?: unknown) => Promise<unknown>) => work()
    );
  });

  it('từ chối request chưa xác thực trước mọi side effect', async () => {
    await handleRecoverProjectArbitrationOnChainDecision({
      params: { arbitrationId: 'ARB-1' }, body: { reason: 'Đã đối soát đầy đủ chữ ký và hạ tầng relay trước khi chạy lại.' }
    } as never, {} as Response);

    expect(mocks.sendErrorResponse).toHaveBeenCalledWith(expect.anything(), 401, expect.any(String), 'UNAUTHENTICATED');
    expect(mocks.recoverOnChainDecision).not.toHaveBeenCalled();
  });

  it('từ chối dữ liệu recovery không hợp lệ trước khi gọi service hoặc ghi audit', async () => {
    await handleRecoverProjectArbitrationOnChainDecision({
      authenticatedUser: { userId: 'admin-1', role: 'admin' }, params: { arbitrationId: ' ' }, body: { reason: 'quá ngắn' }
    } as never, {} as Response);

    expect(mocks.sendErrorResponse).toHaveBeenCalledWith(expect.anything(), 400, expect.any(String), 'VALIDATION_ERROR');
    expect(mocks.recoverOnChainDecision).not.toHaveBeenCalled();
    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
  });

  it('khôi phục phán quyết, ghi audit đúng target và trả trạng thái relay mới', async () => {
    await handleRecoverProjectArbitrationOnChainDecision({
      authenticatedUser: { userId: 'admin-1', role: 'admin' },
      params: { arbitrationId: 'ARB-DLQ' },
      body: { reason: 'Đã đối soát đầy đủ chữ ký, epoch và hạ tầng relay trước khi chạy lại.' }
    } as never, {} as Response);

    expect(mocks.recoverOnChainDecision).toHaveBeenCalledWith('ARB-DLQ');
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 'admin-1',
      actionType: 'ARBITRATION_ON_CHAIN_DECISION_RECOVERED',
      targetId: 'ARB-DLQ',
      targetType: 'PROJECT_ARBITRATION',
      context: { arbitrationId: 'ARB-DLQ', onChainDecisionStatus: 'PENDING' }
    }));
    expect(mocks.sendSuccessResponse).toHaveBeenCalledWith(expect.anything(), 200, expect.any(String), {
      arbitrationId: 'ARB-DLQ', onChainDecisionStatus: 'PENDING'
    });
  });

  it('không ghi audit thành công nếu service từ chối trạng thái hoặc chữ ký', async () => {
    const failure = new Error('signatures are not ready');
    mocks.recoverOnChainDecision.mockRejectedValue(failure);

    await handleRecoverProjectArbitrationOnChainDecision({
      authenticatedUser: { userId: 'admin-1', role: 'admin' },
      params: { arbitrationId: 'ARB-OPEN' },
      body: { reason: 'Đã kiểm tra đầy đủ nhưng phán quyết chưa hợp lệ để khôi phục relay.' }
    } as never, {} as Response);

    expect(mocks.recordAdminAuditLog).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(expect.anything(), failure, expect.any(String));
  });

  it('khong tra thanh cong neu ghi audit sau recovery gap loi', async () => {
    const auditFailure = new Error('audit unavailable');
    mocks.recordAdminAuditLog.mockRejectedValue(auditFailure);
    const response = {} as Response;

    await handleRecoverProjectArbitrationOnChainDecision({
      authenticatedUser: { userId: 'admin-1', role: 'admin' },
      params: { arbitrationId: 'ARB-DLQ' },
      body: { reason: 'Da doi soat day du chu ky, epoch va ha tang relay truoc khi chay lai.' }
    } as never, response);

    expect(mocks.recoverOnChainDecision).toHaveBeenCalledWith('ARB-DLQ');
    expect(mocks.sendSuccessResponse).not.toHaveBeenCalled();
    expect(mocks.sendErrorFromUnknown).toHaveBeenCalledWith(response, auditFailure, expect.any(String));
  });

  it('dung cung session cho recovery va audit trong transaction', async () => {
    const transactionSession = {};
    mocks.runMongoTransaction.mockImplementation(
      async (work: (session?: unknown) => Promise<unknown>) => work(transactionSession)
    );

    await handleRecoverProjectArbitrationOnChainDecision({
      authenticatedUser: { userId: 'admin-1', role: 'admin' },
      params: { arbitrationId: 'ARB-DLQ' },
      body: { reason: 'Da doi soat day du chu ky, epoch va ha tang relay truoc khi chay lai.' }
    } as never, {} as Response);

    expect(mocks.recoverOnChainDecision).toHaveBeenCalledWith('ARB-DLQ', transactionSession);
    expect(mocks.recordAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({ session: transactionSession }));
  });
});
