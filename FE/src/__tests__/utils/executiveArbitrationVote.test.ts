import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  readAuthSession: vi.fn(),
  signCommitteeGovernanceVote: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildSameOriginApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession }));
vi.mock('@/app/utils/committeeGovernanceSigner', () => ({ signCommitteeGovernanceVote: mocks.signCommitteeGovernanceVote }));

import { submitExecutiveArbitrationVote } from '@/app/utils/executiveArbitrationVote';

const voteInput = {
  arbitrationId: 'arbitration-1',
  decision: 'UPHOLD_PROJECT' as const,
  reason: 'Chứng cứ hiện trường xác nhận dự án đáp ứng điều kiện tiếp tục.',
  markedAbusive: false,
  donationLockRiskAcknowledged: false
};

const signingPayload = {
  signingRequestId: 'signing-request-1',
  domain: { name: 'CommitteeGovernance', version: '1', chainId: 80002, verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: { Vote: [{ name: 'kind', type: 'uint8' }] },
  value: { kind: 0, subjectId: `0x${'a'.repeat(64)}`, approved: true, reasonHash: `0x${'b'.repeat(64)}`, committeeEpoch: '7', nonce: '9', deadline: '4000000000' }
};

/** Kiểm thử utility điều phối payload server-issued, chữ ký EIP-712 và submit quyết định. */
describe('submitExecutiveArbitrationVote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'executive-token' });
  });

  it('lấy payload, ký EIP-712 rồi submit đúng chữ ký và Bearer token', async () => {
    mocks.fetchApi
      .mockResolvedValueOnce({ data: signingPayload })
      .mockResolvedValueOnce({ data: { arbitrationId: voteInput.arbitrationId } });
    mocks.signCommitteeGovernanceVote.mockResolvedValue({ signature: '0xsigned', signingRequestId: signingPayload.signingRequestId });

    await expect(submitExecutiveArbitrationVote(voteInput)).resolves.toBeUndefined();

    expect(mocks.signCommitteeGovernanceVote).toHaveBeenCalledWith(signingPayload);
    expect(mocks.fetchApi).toHaveBeenNthCalledWith(1, '/api/project-governance/executive/signing-payload', {
      method: 'POST',
      headers: { Authorization: 'Bearer executive-token' },
      body: JSON.stringify({ arbitrationId: voteInput.arbitrationId, decision: voteInput.decision, reason: voteInput.reason })
    });
    expect(mocks.fetchApi).toHaveBeenNthCalledWith(2, '/api/project-governance/executive/vote', {
      method: 'POST',
      headers: { Authorization: 'Bearer executive-token' },
      body: JSON.stringify({ ...voteInput, eip712Signature: { signature: '0xsigned', signingRequestId: signingPayload.signingRequestId } })
    });
  });

  it('submit không có chữ ký khi server xác định chữ ký không cần thiết', async () => {
    mocks.readAuthSession.mockReturnValue({ accessToken: '' });
    mocks.fetchApi
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: { arbitrationId: voteInput.arbitrationId } });

    await submitExecutiveArbitrationVote({ ...voteInput, decision: 'REJECT_PROJECT' });

    expect(mocks.signCommitteeGovernanceVote).not.toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenLastCalledWith('/api/project-governance/executive/vote', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ ...voteInput, decision: 'REJECT_PROJECT' })
    });
  });

  it('không submit phiếu khi MetaMask từ chối ký payload server-issued', async () => {
    mocks.fetchApi.mockResolvedValueOnce({ data: signingPayload });
    mocks.signCommitteeGovernanceVote.mockRejectedValue(new Error('Ví từ chối ký EIP-712.'));

    await expect(submitExecutiveArbitrationVote(voteInput)).rejects.toThrow('Ví từ chối ký EIP-712.');

    expect(mocks.fetchApi).toHaveBeenCalledTimes(1);
  });

  it('không gọi MetaMask hoặc submit khi API cấp payload gặp lỗi', async () => {
    mocks.fetchApi.mockRejectedValueOnce(new Error('Không thể cấp payload ký.'));

    await expect(submitExecutiveArbitrationVote(voteInput)).rejects.toThrow('Không thể cấp payload ký.');

    expect(mocks.signCommitteeGovernanceVote).not.toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1);
  });
});
