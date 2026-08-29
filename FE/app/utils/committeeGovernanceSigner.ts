import { BrowserProvider, type Eip1193Provider, getAddress } from 'ethers';

export type CommitteeVoteSignaturePayload = {
  signingRequestId: string;
  domain: { name: 'CommitteeGovernance'; version: '1'; chainId: number; verifyingContract: string };
  types: { Vote: Array<{ name: string; type: string }> };
  value: { kind: number; subjectId: string; approved: boolean; reasonHash: string; committeeEpoch: string; nonce: string; deadline: string };
};

type EthereumBrowserWindow = Window & { ethereum?: Eip1193Provider };

/** Ký payload EIP-712 chuẩn do backend tạo; frontend không tự suy diễn domain, epoch hay nonce. */
export async function signCommitteeGovernanceVote(payload: CommitteeVoteSignaturePayload): Promise<{
  signature: string;
  signingRequestId: string;
}> {
  const ethereum = (window as EthereumBrowserWindow).ethereum;
  if (!ethereum) throw new Error('Không tìm thấy MetaMask hoặc ví EVM tương thích.');
  const provider = new BrowserProvider(ethereum);
  await provider.send('eth_requestAccounts', []);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== payload.domain.chainId) {
    throw new Error(`Ví đang ở sai mạng. Vui lòng chuyển sang chain ID ${payload.domain.chainId} rồi thử lại.`);
  }
  const signer = await provider.getSigner();
  // Gọi getAddress để ethers reject địa chỉ provider không hợp lệ trước khi mở popup ký.
  getAddress(await signer.getAddress());
  const signature = await signer.signTypedData(payload.domain, payload.types, {
    ...payload.value,
    committeeEpoch: BigInt(payload.value.committeeEpoch),
    nonce: BigInt(payload.value.nonce),
    deadline: BigInt(payload.value.deadline)
  });
  return { signature, signingRequestId: payload.signingRequestId };
}
