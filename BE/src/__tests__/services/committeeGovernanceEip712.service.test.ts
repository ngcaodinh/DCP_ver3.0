import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  committeeEpoch: vi.fn(),
  createSigningRequest: vi.fn(),
  findSigningRequest: vi.fn(),
  consumeSigningRequest: vi.fn(),
  getNetwork: vi.fn()
}));

vi.mock('../../config/blockchainRpc', () => ({ getBlockchainRpcUrl: () => 'https://rpc.example.test' }));
vi.mock('../../models/committeeVoteSigningRequestModel', () => ({
  createCommitteeVoteSigningRequest: mocks.createSigningRequest,
  findCommitteeVoteSigningRequest: mocks.findSigningRequest,
  consumeCommitteeVoteSigningRequest: mocks.consumeSigningRequest
}));
vi.mock('ethers', async importOriginal => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    JsonRpcProvider: vi.fn(() => ({ getNetwork: mocks.getNetwork })),
    Contract: vi.fn(() => ({ committeeEpoch: mocks.committeeEpoch }))
  };
});

import { Wallet } from 'ethers';
import { prepareCommitteeVoteSignature, readCommitteeEpochFromChain, verifyCommitteeVoteSignature } from '../../services/committeeGovernanceEip712.service';

const CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111';
const VOTER = new Wallet('0x59c6995e998f97a5a0044966f0945383e5de5d8d0a1cbf8d2a8b7f3e8e11f1c5');

describe('committeeGovernanceEip712 service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = CONTRACT_ADDRESS;
    mocks.getNetwork.mockResolvedValue({ chainId: 80002n });
    mocks.committeeEpoch.mockResolvedValue(7n);
    mocks.consumeSigningRequest.mockResolvedValue(true);
    mocks.createSigningRequest.mockImplementation(async payload => ({ ...payload, signingRequestId: '01d743bd-3d53-4cf1-9ce7-8aa3b2819c65', consumedAt: null }));
  });

  it('dựng và xác minh đúng schema Vote canonical từ signing request server-issued', async () => {
    const reason = 'Đã đối chiếu chứng từ giải ngân và ảnh hiện trường.';
    const payload = await prepareCommitteeVoteSignature('DISBURSEMENT', 'REQ-1', 'APPROVE', 'user-1', reason, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    expect(payload?.types.Vote).toEqual([
      { name: 'kind', type: 'uint8' }, { name: 'subjectId', type: 'bytes32' }, { name: 'approved', type: 'bool' },
      { name: 'reasonHash', type: 'bytes32' }, { name: 'committeeEpoch', type: 'uint64' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ]);
    mocks.findSigningRequest.mockResolvedValue({
      signingRequestId: payload!.signingRequestId, kind: 'DISBURSEMENT', businessId: 'REQ-1', voterUserId: 'user-1', decision: 'APPROVE',
      reasonCommitment: (await mocks.createSigningRequest.mock.results[0].value).reasonCommitment,
      committeeEpoch: payload!.value.committeeEpoch, nonce: payload!.value.nonce, deadline: new Date(Number(payload!.value.deadline) * 1000), consumedAt: null
    });
    const signature = await VOTER.signTypedData(payload!.domain, payload!.types, {
      ...payload!.value, committeeEpoch: BigInt(payload!.value.committeeEpoch), nonce: BigInt(payload!.value.nonce), deadline: BigInt(payload!.value.deadline)
    });

    await expect(verifyCommitteeVoteSignature({ kind: 'DISBURSEMENT', businessId: 'REQ-1', decision: 'APPROVE', expectedWalletAddress: VOTER.address, voterUserId: 'user-1', reason, submitted: { signature, signingRequestId: payload!.signingRequestId } }))
      .resolves.toMatchObject({ signature, nonce: payload!.value.nonce });
    expect(mocks.consumeSigningRequest).toHaveBeenCalledWith(payload!.signingRequestId);
  });

  it('từ chối reason khác dù chữ ký hợp lệ vì nonce phải gắn với commitment server-issued', async () => {
    const reason = 'Lý do gốc đủ dài để ký EIP-712.';
    const payload = await prepareCommitteeVoteSignature('DISBURSEMENT', 'REQ-2', 'REJECT', 'user-2', reason, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const request = await mocks.createSigningRequest.mock.results[0].value;
    mocks.findSigningRequest.mockResolvedValue({ ...request, signingRequestId: payload!.signingRequestId, consumedAt: null });
    const signature = await VOTER.signTypedData(payload!.domain, payload!.types, { ...payload!.value, committeeEpoch: BigInt(payload!.value.committeeEpoch), nonce: BigInt(payload!.value.nonce), deadline: BigInt(payload!.value.deadline) });

    await expect(verifyCommitteeVoteSignature({ kind: 'DISBURSEMENT', businessId: 'REQ-2', decision: 'REJECT', expectedWalletAddress: VOTER.address, voterUserId: 'user-2', reason: 'Lý do đã bị sửa sau khi ký EIP-712.', submitted: { signature, signingRequestId: payload!.signingRequestId } }))
      .rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(mocks.consumeSigningRequest).not.toHaveBeenCalled();
  });

  it('cấp deadline phủ thời hạn case thay vì cửa sổ cố định mười lăm phút', async () => {
    const caseDeadline = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const payload = await prepareCommitteeVoteSignature('ARBITRATION', 'ARB-1', 'UPHOLD_PROJECT', 'user-3', 'Đủ căn cứ giữ dự án sau khi đánh giá hồ sơ.', caseDeadline);

    expect(Number(payload!.value.deadline) * 1000).toBeGreaterThan(caseDeadline.getTime());
  });

  it('từ chối chữ ký còn hạn khi committee epoch đã đổi trước lúc submit vote', async () => {
    const reason = 'Chữ ký phải bị vô hiệu khi roster Ủy ban thay đổi giữa lúc người dùng ký và gửi phiếu.';
    const payload = await prepareCommitteeVoteSignature('DISBURSEMENT', 'REQ-EPOCH', 'APPROVE', 'user-epoch', reason, new Date(Date.now() + 60_000));
    const signingRequest = await mocks.createSigningRequest.mock.results[0].value;
    mocks.findSigningRequest.mockResolvedValue({ ...signingRequest, signingRequestId: payload!.signingRequestId, consumedAt: null });
    const signature = await VOTER.signTypedData(payload!.domain, payload!.types, {
      ...payload!.value,
      committeeEpoch: BigInt(payload!.value.committeeEpoch),
      nonce: BigInt(payload!.value.nonce),
      deadline: BigInt(payload!.value.deadline)
    });
    mocks.committeeEpoch.mockResolvedValue(8n);

    await expect(verifyCommitteeVoteSignature({
      kind: 'DISBURSEMENT', businessId: 'REQ-EPOCH', decision: 'APPROVE', expectedWalletAddress: VOTER.address,
      voterUserId: 'user-epoch', reason, submitted: { signature, signingRequestId: payload!.signingRequestId }
    })).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });

    expect(mocks.consumeSigningRequest).not.toHaveBeenCalled();
  });

  it('đọc committee epoch hiện tại từ contract cho guard nghiệp vụ', async () => {
    await expect(readCommitteeEpochFromChain()).resolves.toBe('7');
    expect(mocks.committeeEpoch).toHaveBeenCalledTimes(1);
  });

  it('fail-closed với BLOCKCHAIN_UNAVAILABLE khi RPC không đọc được committee epoch', async () => {
    mocks.committeeEpoch.mockRejectedValue(new Error('rpc unavailable'));

    await expect(readCommitteeEpochFromChain())
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });
  });
});
