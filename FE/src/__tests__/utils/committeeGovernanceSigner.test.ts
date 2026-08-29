import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getNetwork: vi.fn(),
  getSigner: vi.fn(),
  signTypedData: vi.fn(),
  getAddress: vi.fn()
}));

vi.mock('ethers', () => ({
  BrowserProvider: class {
    send = mocks.send;
    getNetwork = mocks.getNetwork;
    getSigner = mocks.getSigner;
  },
  getAddress: mocks.getAddress
}));

import { signCommitteeGovernanceVote, type CommitteeVoteSignaturePayload } from '@/app/utils/committeeGovernanceSigner';

const payload: CommitteeVoteSignaturePayload = {
  signingRequestId: '01d743bd-3d53-4cf1-9ce7-8aa3b2819c65',
  domain: { name: 'CommitteeGovernance', version: '1', chainId: 80002, verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: { Vote: [{ name: 'kind', type: 'uint8' }] },
  value: { kind: 0, subjectId: `0x${'a'.repeat(64)}`, approved: true, reasonHash: `0x${'b'.repeat(64)}`, committeeEpoch: '7', nonce: '9', deadline: '4000000000' }
};

describe('committeeGovernanceSigner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNetwork.mockResolvedValue({ chainId: 80002n });
    mocks.getAddress.mockImplementation((address: string) => address);
    mocks.getSigner.mockResolvedValue({ getAddress: mocks.getAddress, signTypedData: mocks.signTypedData });
    mocks.signTypedData.mockResolvedValue('0xsignature');
    Object.assign(window, { ethereum: { request: vi.fn() } });
  });

  afterEach(() => { delete (window as Window & { ethereum?: unknown }).ethereum; });

  it('gửi nguyên signingRequestId server-issued cùng chữ ký hợp lệ', async () => {
    await expect(signCommitteeGovernanceVote(payload)).resolves.toEqual({ signature: '0xsignature', signingRequestId: payload.signingRequestId });
    expect(mocks.signTypedData).toHaveBeenCalledWith(payload.domain, payload.types, expect.objectContaining({ nonce: 9n, deadline: 4000000000n }));
  });

  it('chặn ví ở sai chain trước khi yêu cầu ký', async () => {
    mocks.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(signCommitteeGovernanceVote(payload)).rejects.toThrow('sai mạng');
    expect(mocks.signTypedData).not.toHaveBeenCalled();
  });

  it('báo lỗi rõ ràng khi chưa cài ví EVM', async () => {
    delete (window as Window & { ethereum?: unknown }).ethereum;
    await expect(signCommitteeGovernanceVote(payload)).rejects.toThrow('Không tìm thấy MetaMask');
  });
});
