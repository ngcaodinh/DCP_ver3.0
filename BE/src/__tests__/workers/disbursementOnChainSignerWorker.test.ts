import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApprovedDisbursementCommitteeVotes: vi.fn(),
  claimApprovedDisbursementCommitteeVote: vi.fn(),
  completeDisbursementCommitteeExecution: vi.fn(),
  releaseDisbursementCommitteeExecution: vi.fn(),
  renewDisbursementCommitteeExecutionLease: vi.fn(),
  claimTechnicalSignerExecutionLock: vi.fn(),
  releaseTechnicalSignerExecutionLock: vi.fn(),
  renewTechnicalSignerExecutionLock: vi.fn(),
  findDisbursementByRequestId: vi.fn(),
  appendDisbursementApprovalIfRoleAbsent: vi.fn(),
  updateDisbursementByRequestId: vi.fn(),
  triggerPayosTransferForApprovedDisbursement: vi.fn(),
  contractConstructor: vi.fn(),
  walletConstructor: vi.fn(),
  getRequest: vi.fn(),
  signRequest: vi.fn(),
  getSignerAddress: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: mocks.loggerInfo, error: mocks.loggerError })
}));
vi.mock('../../config/requestContext', () => ({
  runWithWorkerContext: async (_name: string, work: () => Promise<void>) => work()
}));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: mocks.findDisbursementByRequestId,
  appendDisbursementApprovalIfRoleAbsent: mocks.appendDisbursementApprovalIfRoleAbsent,
  updateDisbursementByRequestId: mocks.updateDisbursementByRequestId
}));
vi.mock('../../models/disbursementCommitteeVoteModel', () => ({
  findApprovedDisbursementCommitteeVotes: mocks.findApprovedDisbursementCommitteeVotes,
  claimApprovedDisbursementCommitteeVote: mocks.claimApprovedDisbursementCommitteeVote,
  completeDisbursementCommitteeExecution: mocks.completeDisbursementCommitteeExecution,
  releaseDisbursementCommitteeExecution: mocks.releaseDisbursementCommitteeExecution,
  renewDisbursementCommitteeExecutionLease: mocks.renewDisbursementCommitteeExecutionLease
}));
vi.mock('../../models/technicalSignerExecutionLockModel', () => ({
  claimTechnicalSignerExecutionLock: mocks.claimTechnicalSignerExecutionLock,
  releaseTechnicalSignerExecutionLock: mocks.releaseTechnicalSignerExecutionLock,
  renewTechnicalSignerExecutionLock: mocks.renewTechnicalSignerExecutionLock
}));
vi.mock('../../workers/payosTransferWorker', () => ({
  triggerPayosTransferForApprovedDisbursement: mocks.triggerPayosTransferForApprovedDisbursement
}));
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn(),
    Contract: mocks.contractConstructor,
    Wallet: mocks.walletConstructor
  }
}));

import { runDisbursementOnChainSignerCycle } from '../../workers/disbursementOnChainSignerWorker';

const originalRpcUrl = process.env.BLOCKCHAIN_RPC_URL;
const originalContractAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS;
const originalRelayerWorkerEnabled = process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER;

/** Tạo snapshot contract tại đúng các index ABI mà worker phải đọc. */
function makeOnChainRequest(status: number, signedFields: [boolean, boolean, boolean] = [false, false, false], requiredApprovals = 3): unknown[] {
  const request: unknown[] = Array.from({ length: 21 }, () => null);
  request[5] = status;
  request[14] = 1_900_000_000;
  request[17] = requiredApprovals;
  request[18] = signedFields[0];
  request[19] = signedFields[1];
  request[20] = signedFields[2];
  return request;
}

/** Tạo committee case đã được claim để test luôn đi qua fencing và heartbeat boundary. */
function makeClaimedCase(requestId: string, executionAttemptCount = 1): { requestId: string; executionLeaseId: string; executionAttemptCount: number } {
  return { requestId, executionLeaseId: 'case-lease', executionAttemptCount };
}

/** Tạo disbursement tối thiểu cho nhánh worker đọc chain. */
function makePendingDisbursement(requestId: string): { requestId: string; status: 'PENDING'; onChainRequestId: number; payosTransferStatus: null } {
  return { requestId, status: 'PENDING', onChainRequestId: 1, payosTransferStatus: null };
}

describe('disbursementOnChainSignerWorker state machine', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.example.test';
    process.env.MULTISIG_DISBURSEMENT_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.DISBURSEMENT_SERVICE_SIGNER_ADMIN_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.DISBURSEMENT_SERVICE_SIGNER_ORG_KEY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    process.env.DISBURSEMENT_SERVICE_SIGNER_REGULATORY_KEY = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    mocks.claimTechnicalSignerExecutionLock.mockImplementation(async (leaseId: string) => ({ leaseId, fencingToken: 1 }));
    mocks.renewTechnicalSignerExecutionLock.mockResolvedValue(true);
    mocks.renewDisbursementCommitteeExecutionLease.mockResolvedValue(true);
    mocks.getSignerAddress.mockResolvedValue('0x2222222222222222222222222222222222222222');
    mocks.triggerPayosTransferForApprovedDisbursement.mockResolvedValue({ enqueued: true });
    mocks.appendDisbursementApprovalIfRoleAbsent.mockResolvedValue({});
    mocks.updateDisbursementByRequestId.mockResolvedValue({});
    mocks.contractConstructor.mockImplementation(() => ({
      getRequest: mocks.getRequest,
      connect: () => ({ signRequest: mocks.signRequest })
    }));
    mocks.walletConstructor.mockImplementation(() => ({ getAddress: mocks.getSignerAddress }));
  });

  afterEach(() => {
    if (originalRpcUrl === undefined) delete process.env.BLOCKCHAIN_RPC_URL;
    else process.env.BLOCKCHAIN_RPC_URL = originalRpcUrl;
    if (originalContractAddress === undefined) delete process.env.MULTISIG_DISBURSEMENT_ADDRESS;
    else process.env.MULTISIG_DISBURSEMENT_ADDRESS = originalContractAddress;
    if (originalRelayerWorkerEnabled === undefined) delete process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER;
    else process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER = originalRelayerWorkerEnabled;
    delete process.env.DISBURSEMENT_SERVICE_SIGNER_ADMIN_KEY;
    delete process.env.DISBURSEMENT_SERVICE_SIGNER_ORG_KEY;
    delete process.env.DISBURSEMENT_SERVICE_SIGNER_REGULATORY_KEY;
  });

  it('does not claim any case while another instance holds the distributed technical signer lock', async () => {
    mocks.claimTechnicalSignerExecutionLock.mockResolvedValueOnce(null);
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([]);

    await runDisbursementOnChainSignerCycle();

    expect(mocks.findApprovedDisbursementCommitteeVotes).not.toHaveBeenCalled();
    expect(mocks.releaseTechnicalSignerExecutionLock).not.toHaveBeenCalled();
  });

  it('continues with the next case after a retryable failure without parallelizing the shared signers', async () => {
    const order: string[] = [];
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([{ requestId: 'REQ-1' }, { requestId: 'REQ-2' }]);
    mocks.claimApprovedDisbursementCommitteeVote.mockImplementation(async (requestId: string) => {
      order.push(`claim:${requestId}`);
      return makeClaimedCase(requestId);
    });
    mocks.findDisbursementByRequestId
      .mockResolvedValueOnce(makePendingDisbursement('REQ-1'))
      .mockResolvedValueOnce({ requestId: 'REQ-2', status: 'COMPLETED', payosTransferStatus: 'SUCCESS' });
    mocks.getRequest.mockRejectedValueOnce(new Error('RPC unavailable'));
    mocks.releaseDisbursementCommitteeExecution.mockImplementation(async (requestId: string) => { order.push(`release:${requestId}`); });
    mocks.completeDisbursementCommitteeExecution.mockImplementation(async (requestId: string) => { order.push(`complete:${requestId}`); });

    await runDisbursementOnChainSignerCycle();

    expect(order).toEqual(['claim:REQ-1', 'release:REQ-1', 'claim:REQ-2', 'complete:REQ-2']);
    expect(mocks.releaseDisbursementCommitteeExecution).toHaveBeenCalledWith('REQ-1', expect.any(String), 1, 'RPC unavailable');
  });

  it('reconciles a restart after chain APPROVED by enqueueing PayOS before completing the case', async () => {
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([{ requestId: 'REQ-1' }]);
    mocks.claimApprovedDisbursementCommitteeVote.mockResolvedValue(makeClaimedCase('REQ-1'));
    mocks.findDisbursementByRequestId.mockResolvedValue(makePendingDisbursement('REQ-1'));
    mocks.getRequest.mockResolvedValue(makeOnChainRequest(2, [false, false, false], 5));

    await runDisbursementOnChainSignerCycle();

    expect(mocks.updateDisbursementByRequestId).toHaveBeenCalledWith('REQ-1', expect.objectContaining({ status: 'APPROVED', requiredApprovals: 5 }));
    expect(mocks.triggerPayosTransferForApprovedDisbursement).toHaveBeenCalledWith('REQ-1');
    expect(mocks.completeDisbursementCommitteeExecution).toHaveBeenCalledWith('REQ-1', expect.any(String));
  });

  it('releases the case when PayOS enqueue fails after the final on-chain signature', async () => {
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([{ requestId: 'REQ-1' }]);
    mocks.claimApprovedDisbursementCommitteeVote.mockResolvedValue(makeClaimedCase('REQ-1', 3));
    mocks.findDisbursementByRequestId.mockResolvedValue(makePendingDisbursement('REQ-1'));
    mocks.getRequest
      .mockResolvedValueOnce(makeOnChainRequest(1))
      .mockResolvedValueOnce(makeOnChainRequest(2, [true, false, false]));
    mocks.signRequest.mockResolvedValue({ hash: '0xtx', wait: async () => ({ status: 1 }) });
    mocks.triggerPayosTransferForApprovedDisbursement.mockRejectedValue(new Error('PayOS unavailable'));

    await runDisbursementOnChainSignerCycle();

    expect(mocks.appendDisbursementApprovalIfRoleAbsent).toHaveBeenCalledOnce();
    expect(mocks.completeDisbursementCommitteeExecution).not.toHaveBeenCalled();
    expect(mocks.releaseDisbursementCommitteeExecution).toHaveBeenCalledWith('REQ-1', expect.any(String), 3, 'PayOS unavailable');
  });

  it('không tạo side effect lần hai khi chu kỳ kế tiếp không còn case approved để claim', async () => {
    mocks.findApprovedDisbursementCommitteeVotes
      .mockResolvedValueOnce([{ requestId: 'REQ-1' }])
      .mockResolvedValueOnce([]);
    mocks.claimApprovedDisbursementCommitteeVote.mockResolvedValue(makeClaimedCase('REQ-1'));
    mocks.findDisbursementByRequestId.mockResolvedValue(makePendingDisbursement('REQ-1'));
    mocks.getRequest.mockResolvedValue(makeOnChainRequest(2));

    await runDisbursementOnChainSignerCycle();
    await runDisbursementOnChainSignerCycle();

    expect(mocks.claimApprovedDisbursementCommitteeVote).toHaveBeenCalledOnce();
    expect(mocks.triggerPayosTransferForApprovedDisbursement).toHaveBeenCalledOnce();
    expect(mocks.completeDisbursementCommitteeExecution).toHaveBeenCalledOnce();
  });

  it('continues after AlreadySigned and records the remaining signatures through chain approval', async () => {
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([{ requestId: 'REQ-1' }]);
    mocks.claimApprovedDisbursementCommitteeVote.mockResolvedValue(makeClaimedCase('REQ-1'));
    mocks.findDisbursementByRequestId.mockResolvedValue(makePendingDisbursement('REQ-1'));
    mocks.getRequest
      .mockResolvedValueOnce(makeOnChainRequest(1))
      .mockResolvedValueOnce(makeOnChainRequest(1, [true, false, false]))
      .mockResolvedValueOnce(makeOnChainRequest(1, [true, true, false]))
      .mockResolvedValueOnce(makeOnChainRequest(2, [true, true, true]));
    mocks.signRequest
      .mockRejectedValueOnce(new Error('RoleAlreadySigned'))
      .mockResolvedValueOnce({ hash: '0xtx-org', wait: async () => ({ status: 1 }) })
      .mockResolvedValueOnce({ hash: '0xtx-regulatory', wait: async () => ({ status: 1 }) });

    await runDisbursementOnChainSignerCycle();

    expect(mocks.signRequest).toHaveBeenCalledTimes(3);
    expect(mocks.appendDisbursementApprovalIfRoleAbsent).toHaveBeenCalledTimes(2);
    expect(mocks.completeDisbursementCommitteeExecution).toHaveBeenCalledWith('REQ-1', expect.any(String));
  });

  it('không claim hoặc tiêu retry khi relayer chưa ghi DecisionRecorded cho case chờ chain', async () => {
    process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER = 'true';
    mocks.findApprovedDisbursementCommitteeVotes.mockResolvedValue([]);

    await runDisbursementOnChainSignerCycle();

    expect(mocks.findApprovedDisbursementCommitteeVotes).toHaveBeenCalledWith(20, true);
    expect(mocks.claimApprovedDisbursementCommitteeVote).not.toHaveBeenCalled();
    expect(mocks.releaseDisbursementCommitteeExecution).not.toHaveBeenCalled();
  });
});
