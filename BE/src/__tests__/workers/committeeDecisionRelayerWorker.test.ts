import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findResolvedDisbursements: vi.fn(),
  deadLetterDisbursementDecision: vi.fn(),
  markDisbursementRecorded: vi.fn(),
  markDisbursementNeedsResign: vi.fn(),
  releaseDisbursementDecision: vi.fn(),
  findResolvedArbitrations: vi.fn(),
  deadLetterArbitrationDecision: vi.fn(),
  markArbitrationRecorded: vi.fn(),
  markArbitrationNeedsResign: vi.fn(),
  releaseArbitrationDecision: vi.fn(),
  createCommitteeSnapshot: vi.fn(),
  ensureCommitteeRoster: vi.fn(),
  createUserNotification: vi.fn(),
  claimLock: vi.fn(),
  releaseLock: vi.fn(),
  renewLock: vi.fn(),
  contractConstructor: vi.fn(),
  walletConstructor: vi.fn(),
  decisionRecorded: vi.fn(),
  committeeEpoch: vi.fn(),
  recordDecision: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  findUsersByRole: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError })
}));
vi.mock('../../config/requestContext', () => ({
  runWithWorkerContext: async (_name: string, work: () => Promise<void>) => work()
}));
vi.mock('../../models/disbursementCommitteeVoteModel', () => ({
  deadLetterDisbursementCommitteeOnChainDecision: mocks.deadLetterDisbursementDecision,
  findResolvedDisbursementCommitteeVotesNeedingOnChainDecision: mocks.findResolvedDisbursements,
  markDisbursementCommitteeDecisionRecorded: mocks.markDisbursementRecorded,
  markDisbursementCommitteeDecisionNeedsResign: mocks.markDisbursementNeedsResign,
  releaseDisbursementCommitteeOnChainDecision: mocks.releaseDisbursementDecision
}));
vi.mock('../../models/projectArbitrationModel', () => ({
  deadLetterProjectArbitrationOnChainDecision: mocks.deadLetterArbitrationDecision,
  findResolvedProjectArbitrationsNeedingOnChainDecision: mocks.findResolvedArbitrations,
  markProjectArbitrationDecisionRecorded: mocks.markArbitrationRecorded,
  markProjectArbitrationDecisionNeedsResign: mocks.markArbitrationNeedsResign,
  releaseProjectArbitrationOnChainDecision: mocks.releaseArbitrationDecision
}));
vi.mock('../../models/authModel', () => ({ findUsersByRole: mocks.findUsersByRole }));
vi.mock('../../models/technicalSignerExecutionLockModel', () => ({
  claimTechnicalSignerExecutionLock: mocks.claimLock,
  releaseTechnicalSignerExecutionLock: mocks.releaseLock,
  renewTechnicalSignerExecutionLock: mocks.renewLock
}));
vi.mock('../../services/committeeGovernanceEip712.service', () => ({
  getCommitteeDecisionSubjectId: (kind: string, businessId: string) => `subject:${kind}:${businessId}`,
  getCommitteeDecisionReasonHash: (kind: string, businessId: string, approved: boolean) => `reason:${kind}:${businessId}:${approved}`
}));
vi.mock('../../services/disbursementCommitteeVoting.service', () => ({
  createDisbursementCommitteeSnapshot: mocks.createCommitteeSnapshot,
  DISBURSEMENT_COMMITTEE_RESIGN_VOTING_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  ensureExecutiveCommitteeRosterReady: mocks.ensureCommitteeRoster
}));
vi.mock('../../services/notificationService', () => ({ createUserNotification: mocks.createUserNotification }));
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn(),
    Wallet: mocks.walletConstructor,
    Contract: mocks.contractConstructor,
    isAddress: (address: string) => address.startsWith('0x'),
    getAddress: (address: string) => address,
    keccak256: (value: string) => `hash:${value}`,
    AbiCoder: { defaultAbiCoder: () => ({ encode: () => 'encoded' }) }
  }
}));

import { runCommitteeDecisionRelayerCycle } from '../../workers/committeeDecisionRelayerWorker';

const originalEnvironment = {
  rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  contractAddress: process.env.COMMITTEE_GOVERNANCE_ADDRESS,
  relayerKey: process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY
};
const ACTIVE_SIGNATURE_DEADLINE = new Date(Date.now() + 60 * 60 * 1000);
const EXPIRED_SIGNATURE_DEADLINE = new Date('2020-01-01T00:00:00.000Z');

/** Tạo case giải ngân đã chốt với bộ chữ ký hợp lệ để từng test thay đổi đúng state cần kiểm tra. */
function makeResolvedDisbursement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const deadline = ACTIVE_SIGNATURE_DEADLINE;
  return {
    requestId: 'REQ-1',
    status: 'APPROVED',
    resolvedAt: new Date(),
    committeeSnapshot: [
      { userId: 'chair', role: 'executive_chair', walletAddress: '0xchair', governanceWalletAddress: '0xchair-governance' },
      { userId: 'member-1', role: 'executive_member', walletAddress: '0xmember-1', governanceWalletAddress: null },
      { userId: 'member-2', role: 'executive_member', walletAddress: '0xmember-2', governanceWalletAddress: null }
    ],
    votes: [
      { voterUserId: 'chair', decision: 'APPROVE', signature: '0xsig-chair', nonce: '1', deadline, committeeEpoch: '7' },
      { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xsig-member-1', nonce: '2', deadline, committeeEpoch: '7' },
      { voterUserId: 'member-2', decision: 'APPROVE', signature: '0xsig-member-2', nonce: '3', deadline, committeeEpoch: '7' }
    ],
    ...overrides
  };
}

/** Tạo phán quyết xét xử đã chốt với ngưỡng Chair và hai Member hợp lệ. */
function makeResolvedArbitration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arbitrationId: 'ARB-1',
    status: 'RESOLVED',
    verdict: 'UPHOLD_PROJECT',
    resolvedAt: new Date(),
    committeeSnapshot: [
      { userId: 'chair', role: 'executive_chair', walletAddress: '0xchair' },
      { userId: 'member-1', role: 'executive_member', walletAddress: '0xmember-1' },
      { userId: 'member-2', role: 'executive_member', walletAddress: '0xmember-2' }
    ],
    votes: [
      { voterUserId: 'chair', decision: 'UPHOLD_PROJECT', signature: '0xsig-chair', nonce: '1', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-1', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-1', nonce: '2', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-2', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-2', nonce: '3', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' }
    ],
    ...overrides
  };
}

/** Tạo phán quyết đã chốt nhưng toàn bộ chữ ký hết hạn để kiểm tra nhánh NEEDS_RESIGN. */
function makeArbitrationRequiringResign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeResolvedArbitration({
    votes: [
      { voterUserId: 'chair', decision: 'UPHOLD_PROJECT', signature: '0xsig-chair', nonce: '1', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-1', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-1', nonce: '2', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-2', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-2', nonce: '3', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' }
    ],
    ...overrides
  });
}

describe('committeeDecisionRelayerWorker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.example.test';
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    mocks.claimLock.mockImplementation(async (leaseId: string) => ({ leaseId, fencingToken: 7 }));
    mocks.renewLock.mockResolvedValue(true);
    mocks.findResolvedDisbursements.mockResolvedValue([]);
    mocks.findResolvedArbitrations.mockResolvedValue([]);
    mocks.decisionRecorded.mockResolvedValue(false);
    mocks.committeeEpoch.mockResolvedValue(7n);
    mocks.recordDecision.mockResolvedValue({ hash: '0xreceipt', wait: async () => ({ status: 1 }) });
    mocks.markDisbursementNeedsResign.mockResolvedValue(true);
    mocks.markArbitrationNeedsResign.mockResolvedValue(true);
    mocks.createUserNotification.mockResolvedValue(null);
    mocks.ensureCommitteeRoster.mockResolvedValue([
      { id: 'new-chair', role: 'executive_chair', fullName: 'Chủ tịch mới', walletAddress: '0xnew-chair' },
      { id: 'new-member-1', role: 'executive_member', fullName: 'Ủy viên mới 1', walletAddress: '0xnew-member-1' },
      { id: 'new-member-2', role: 'executive_member', fullName: 'Ủy viên mới 2', walletAddress: '0xnew-member-2' },
      { id: 'new-member-3', role: 'executive_member', fullName: 'Ủy viên mới 3', walletAddress: '0xnew-member-3' },
      { id: 'new-member-4', role: 'executive_member', fullName: 'Ủy viên mới 4', walletAddress: '0xnew-member-4' }
    ]);
    mocks.createCommitteeSnapshot.mockReturnValue([
      { userId: 'new-chair', role: 'executive_chair', fullName: 'Chủ tịch mới', walletAddress: '0xnew-chair', governanceWalletAddress: null },
      { userId: 'new-member-1', role: 'executive_member', fullName: 'Ủy viên mới 1', walletAddress: '0xnew-member-1', governanceWalletAddress: null },
      { userId: 'new-member-2', role: 'executive_member', fullName: 'Ủy viên mới 2', walletAddress: '0xnew-member-2', governanceWalletAddress: null },
      { userId: 'new-member-3', role: 'executive_member', fullName: 'Ủy viên mới 3', walletAddress: '0xnew-member-3', governanceWalletAddress: null },
      { userId: 'new-member-4', role: 'executive_member', fullName: 'Ủy viên mới 4', walletAddress: '0xnew-member-4', governanceWalletAddress: null }
    ]);
    mocks.contractConstructor.mockImplementation(() => ({ decisionRecorded: mocks.decisionRecorded, committeeEpoch: mocks.committeeEpoch, recordDecision: mocks.recordDecision }));
    mocks.walletConstructor.mockImplementation(() => ({}));
  });

  afterEach(() => {
    if (originalEnvironment.rpcUrl === undefined) delete process.env.BLOCKCHAIN_RPC_URL;
    else process.env.BLOCKCHAIN_RPC_URL = originalEnvironment.rpcUrl;
    if (originalEnvironment.contractAddress === undefined) delete process.env.COMMITTEE_GOVERNANCE_ADDRESS;
    else process.env.COMMITTEE_GOVERNANCE_ADDRESS = originalEnvironment.contractAddress;
    if (originalEnvironment.relayerKey === undefined) delete process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY;
    else process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY = originalEnvironment.relayerKey;
  });

  it('relays đúng Chair + hai Member cùng phía và lưu receipt đầu tiên', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement()]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).toHaveBeenCalledWith(
      0,
      'subject:DISBURSEMENT:REQ-1',
      true,
      'reason:DISBURSEMENT:REQ-1:true',
      [
        { signer: '0xchair-governance', nonce: '1', deadline: Math.floor(ACTIVE_SIGNATURE_DEADLINE.getTime() / 1000).toString(), signature: '0xsig-chair' },
        { signer: '0xmember-1', nonce: '2', deadline: Math.floor(ACTIVE_SIGNATURE_DEADLINE.getTime() / 1000).toString(), signature: '0xsig-member-1' },
        { signer: '0xmember-2', nonce: '3', deadline: Math.floor(ACTIVE_SIGNATURE_DEADLINE.getTime() / 1000).toString(), signature: '0xsig-member-2' }
      ]
    );
    expect(mocks.markDisbursementRecorded).toHaveBeenCalledWith('REQ-1', '0xreceipt');
    expect(mocks.releaseLock).toHaveBeenCalledWith(expect.any(String), 7, 'committee-governance-decision-relayer');
  });

  it('relay phán quyết xét xử với decision kind riêng và lưu receipt', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeResolvedArbitration()]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).toHaveBeenCalledWith(
      1,
      'subject:ARBITRATION:ARB-1',
      true,
      'reason:ARBITRATION:ARB-1:true',
      expect.any(Array)
    );
    expect(mocks.markArbitrationRecorded).toHaveBeenCalledWith('ARB-1', '0xreceipt');
  });

  it('không phát giao dịch lại khi mapping on-chain đã ghi nhận', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement()]);
    mocks.decisionRecorded.mockResolvedValue(true);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markDisbursementRecorded).toHaveBeenCalledWith('REQ-1', null);
  });

  it('lưu trạng thái recorded khi RPC mất phản hồi sau khi contract đã ghi quyết định', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement()]);
    mocks.recordDecision.mockRejectedValue(new Error('RPC response lost'));
    mocks.decisionRecorded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.markDisbursementRecorded).toHaveBeenCalledWith('REQ-1', null);
    expect(mocks.releaseDisbursementDecision).not.toHaveBeenCalled();
  });

  it('đưa vào retry khi receipt giao dịch trả trạng thái thất bại', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement({ onChainDecisionAttemptCount: 1 })]);
    mocks.recordDecision.mockResolvedValue({ hash: '0xfailed-receipt', wait: async () => ({ status: 0 }) });

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.releaseDisbursementDecision).toHaveBeenCalledWith('REQ-1', 2, expect.stringContaining('không thành công'));
  });

  it('giữ case ở trạng thái chờ nếu thiếu một Member ký cùng phía', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement({ votes: [
      { voterUserId: 'chair', decision: 'APPROVE', signature: '0xsig-chair', nonce: '1', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xsig-member-1', nonce: '2', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' }
    ] })]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markDisbursementRecorded).not.toHaveBeenCalled();
    expect(mocks.deadLetterDisbursementDecision).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('chưa có đủ chữ ký'), expect.objectContaining({ businessId: 'REQ-1' }));
  });

  it('đưa case thiếu chữ ký quá 24 giờ vào DLQ để không chặn đầu hàng đợi relayer', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement({
      resolvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      votes: [
        { voterUserId: 'chair', decision: 'APPROVE', signature: '0xsig-chair', nonce: '1', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' },
        { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xsig-member-1', nonce: '2', deadline: ACTIVE_SIGNATURE_DEADLINE, committeeEpoch: '7' }
      ]
    })]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.deadLetterDisbursementDecision).toHaveBeenCalledWith('REQ-1', expect.stringContaining('quá 24 giờ'));
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('DLQ'), expect.objectContaining({ businessId: 'REQ-1' }));
  });

  it('đưa phán quyết xét xử thiếu chữ ký quá 24 giờ vào DLQ', async () => {
    const arbitration = makeResolvedArbitration();
    mocks.findResolvedArbitrations.mockResolvedValue([makeResolvedArbitration({
      resolvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      votes: (arbitration.votes as Array<Record<string, unknown>>).slice(0, 2)
    })]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.deadLetterArbitrationDecision).toHaveBeenCalledWith('ARB-1', expect.stringContaining('quá 24 giờ'));
  });

  it('bỏ qua phán quyết timeout hoặc không đồng thuận vì contract không có chữ ký cùng phía để ghi', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([
      { arbitrationId: 'ARB-TIMEOUT', status: 'RESOLVED', verdict: 'TIMEOUT', committeeSnapshot: [], votes: [] },
      { arbitrationId: 'ARB-NO-CONSENSUS', status: 'RESOLVED', verdict: 'NO_CONSENSUS', committeeSnapshot: [], votes: [] }
    ]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markArbitrationRecorded).not.toHaveBeenCalled();
  });

  it('chuyển NEEDS_RESIGN thay vì phát giao dịch với bộ chữ ký đã hết hạn', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement({ votes: [
      { voterUserId: 'chair', decision: 'APPROVE', signature: '0xsig-chair', nonce: '1', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xsig-member-1', nonce: '2', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' },
      { voterUserId: 'member-2', decision: 'APPROVE', signature: '0xsig-member-2', nonce: '3', deadline: EXPIRED_SIGNATURE_DEADLINE, committeeEpoch: '7' }
    ] })]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markDisbursementNeedsResign).toHaveBeenCalledWith('REQ-1', expect.stringContaining('Epoch Ủy ban'), expect.objectContaining({
      committeeSnapshot: expect.arrayContaining([expect.objectContaining({ userId: 'new-chair' })]), deadlineAt: expect.any(Date)
    }));
  });

  it('mở lại vòng ký xét xử với roster mới và yêu cầu cả năm ghế bỏ phiếu lại', async () => {
    const expiredDeadline = new Date(Date.now() - 60_000);
    const arbitration = {
      arbitrationId: 'ARB-1',
      status: 'RESOLVED',
      verdict: 'UPHOLD_PROJECT',
      resolvedAt: new Date(),
      onChainDecisionRecoveryCount: 0,
      committeeSnapshot: [
        { userId: 'chair', role: 'executive_chair', walletAddress: '0x1111111111111111111111111111111111111111' },
        { userId: 'member-1', role: 'executive_member', walletAddress: '0x2222222222222222222222222222222222222222' },
        { userId: 'member-2', role: 'executive_member', walletAddress: '0x3333333333333333333333333333333333333333' }
      ],
      votes: [
        { voterUserId: 'chair', decision: 'UPHOLD_PROJECT', signature: '0xsig-chair', nonce: '1', deadline: expiredDeadline, committeeEpoch: '7' },
        { voterUserId: 'member-1', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-1', nonce: '2', deadline: expiredDeadline, committeeEpoch: '7' },
        { voterUserId: 'member-2', decision: 'UPHOLD_PROJECT', signature: '0xsig-member-2', nonce: '3', deadline: expiredDeadline, committeeEpoch: '7' }
      ]
    };
    mocks.findResolvedArbitrations.mockResolvedValue([arbitration]);
    await runCommitteeDecisionRelayerCycle();
    expect(mocks.markArbitrationNeedsResign).toHaveBeenCalledWith('ARB-1', expect.stringContaining('Epoch Ủy ban'), expect.objectContaining({
      committeeSnapshot: expect.arrayContaining([expect.objectContaining({ userId: 'new-chair' })]),
      deadlineAt: expect.any(Date)
    }));
    expect(mocks.createUserNotification).toHaveBeenCalledTimes(5);
    expect(mocks.createUserNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'new-chair',
      notificationType: 'COMMITTEE_RESIGN_REQUIRED',
      content: expect.stringContaining('bỏ phiếu lại')
    }));
  });

  it('mở round ký lại xét xử khi epoch chain đổi dù chữ ký cũ chưa hết hạn', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeResolvedArbitration()]);
    mocks.committeeEpoch.mockResolvedValue(8n);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markArbitrationNeedsResign).toHaveBeenCalledWith('ARB-1', expect.stringContaining('Epoch Ủy ban'), {
      committeeSnapshot: [
        expect.objectContaining({ userId: 'new-chair', role: 'executive_chair', walletAddress: '0xnew-chair' }),
        expect.objectContaining({ userId: 'new-member-1', role: 'executive_member', walletAddress: '0xnew-member-1' }),
        expect.objectContaining({ userId: 'new-member-2', role: 'executive_member', walletAddress: '0xnew-member-2' }),
        expect.objectContaining({ userId: 'new-member-3', role: 'executive_member', walletAddress: '0xnew-member-3' }),
        expect.objectContaining({ userId: 'new-member-4', role: 'executive_member', walletAddress: '0xnew-member-4' })
      ],
      deadlineAt: expect.any(Date)
    });
    expect(mocks.createUserNotification).toHaveBeenCalledTimes(5);
  });

  it('không phụ thuộc recovery attempt cũ khi mở round ký xét xử mới', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeArbitrationRequiringResign({
      onChainDecisionAttemptCount: 99
    })]);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.markArbitrationNeedsResign).toHaveBeenCalledWith('ARB-1', expect.any(String), expect.objectContaining({ deadlineAt: expect.any(Date) }));
    expect(mocks.createUserNotification).toHaveBeenCalledTimes(5);
  });

  it('không gửi thông báo ký lại khi transition nguyên tử đã bị instance khác chiếm', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeArbitrationRequiringResign()]);
    mocks.markArbitrationNeedsResign.mockResolvedValue(false);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.markArbitrationNeedsResign).toHaveBeenCalledOnce();
    expect(mocks.createUserNotification).not.toHaveBeenCalled();
  });

  it('không tạo notification khi không có roster mới nhưng vẫn giữ phán quyết cũ an toàn', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeArbitrationRequiringResign()]);
    mocks.ensureCommitteeRoster.mockRejectedValue(new Error('roster invalid'));

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.markArbitrationNeedsResign).not.toHaveBeenCalled();
    expect(mocks.createUserNotification).not.toHaveBeenCalled();
  });

  it('giữ trạng thái NEEDS_RESIGN khi một notification ký lại xét xử bị lỗi', async () => {
    mocks.findResolvedArbitrations.mockResolvedValue([makeArbitrationRequiringResign()]);
    mocks.createUserNotification.mockRejectedValueOnce(new Error('notification queue unavailable'));

    await expect(runCommitteeDecisionRelayerCycle()).resolves.toBeUndefined();

    expect(mocks.markArbitrationNeedsResign).toHaveBeenCalledWith('ARB-1', expect.any(String), expect.any(Object));
    expect(mocks.createUserNotification).toHaveBeenCalledTimes(5);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Không thể gửi đủ thông báo'),
      expect.objectContaining({ kind: 'ARBITRATION', businessId: 'ARB-1' })
    );
  });

  it('chuyển NEEDS_RESIGN khi epoch contract đổi sau lúc các chữ ký đã được thu thập', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement()]);
    mocks.committeeEpoch.mockResolvedValue(8n);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.markDisbursementNeedsResign).toHaveBeenCalledWith('REQ-1', expect.stringContaining('Epoch Ủy ban'), expect.objectContaining({
      committeeSnapshot: expect.arrayContaining([expect.objectContaining({ userId: 'new-chair' })]), deadlineAt: expect.any(Date)
    }));
  });

  it('đặt retry có attempt count khi RPC relay lỗi thay vì thử lại mỗi chu kỳ vô hạn', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement({ onChainDecisionAttemptCount: 3 })]);
    mocks.recordDecision.mockRejectedValue(new Error('RPC unavailable'));

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.releaseDisbursementDecision).toHaveBeenCalledWith('REQ-1', 4, 'RPC unavailable');
  });

  it('không đọc queue hoặc claim lock khi cấu hình relayer chưa đầy đủ', async () => {
    delete process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY;

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.claimLock).not.toHaveBeenCalled();
    expect(mocks.findResolvedDisbursements).not.toHaveBeenCalled();
    expect(mocks.findResolvedArbitrations).not.toHaveBeenCalled();
  });

  it('không đọc queue khi không claim được technical signer lock', async () => {
    mocks.claimLock.mockResolvedValue(null);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.findResolvedDisbursements).not.toHaveBeenCalled();
    expect(mocks.findResolvedArbitrations).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('đánh dấu NEEDS_RESIGN và gửi notification cho toàn bộ snapshot dù một notification bị lỗi', async () => {
    mocks.findResolvedDisbursements.mockResolvedValue([makeResolvedDisbursement()]);
    mocks.committeeEpoch.mockResolvedValue(8n);
    mocks.createUserNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('notification queue unavailable'))
      .mockResolvedValueOnce(undefined);

    await runCommitteeDecisionRelayerCycle();

    expect(mocks.markDisbursementNeedsResign).toHaveBeenCalledWith('REQ-1', expect.stringContaining('Epoch Ủy ban'), expect.objectContaining({
      committeeSnapshot: expect.arrayContaining([expect.objectContaining({ userId: 'new-chair' })]), deadlineAt: expect.any(Date)
    }));
    expect(mocks.createUserNotification).toHaveBeenCalledTimes(5);
    expect(mocks.createUserNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId: 'new-chair', notificationType: 'COMMITTEE_RESIGN_REQUIRED' }));
    expect(mocks.createUserNotification).toHaveBeenNthCalledWith(5, expect.objectContaining({ userId: 'new-member-4', channels: ['IN_APP'] }));
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('thông báo cần ký lại'), expect.objectContaining({ businessId: 'REQ-1' }));
  });
});
