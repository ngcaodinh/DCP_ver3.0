import { BrowserProvider, Contract, JsonRpcProvider, getAddress, isAddress, type Eip1193Provider } from 'ethers';

export type CommitteeSeatRoleCode = 1 | 2;

export type CommitteeSeatChangeSignature = {
  signer: string;
  nonce: string;
  deadline: string;
  signature: string;
};

export type CommitteeSeatChangeDraft = {
  oldSeat: string;
  newSeat: string;
  role: CommitteeSeatRoleCode;
  committeeEpoch: string;
  deadline: string;
  chainId: string;
  signatures: CommitteeSeatChangeSignature[];
};

type EthereumBrowserWindow = Window & { ethereum?: Eip1193Provider };

const committeeSeatChangeAbi = [
  'function committeeEpoch() view returns (uint64)',
  'function nonceBitmap(address,uint248) view returns (uint256)',
  'function proposeSeatChange(address oldSeat,address newSeat,uint8 role,(address signer,uint256 nonce,uint256 deadline,bytes signature)[] signatures) returns (uint256)',
  'function executeSeatChange(uint256 proposalId)'
];

const seatChangeTypes = {
  SeatChange: [
    { name: 'oldSeat', type: 'address' },
    { name: 'newSeat', type: 'address' },
    { name: 'role', type: 'uint8' },
    { name: 'committeeEpoch', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

/** Chuẩn hóa dữ liệu draft trước khi ký hoặc gửi chain để một draft copy/paste không đổi ý nghĩa EIP-712. */
function normalizeDraft(value: CommitteeSeatChangeDraft): CommitteeSeatChangeDraft {
  if (!isAddress(value.oldSeat) || !isAddress(value.newSeat) || getAddress(value.oldSeat) === getAddress(value.newSeat)) {
    throw new Error('Địa chỉ ghế cũ và ghế mới không hợp lệ.');
  }
  if (value.role !== 1 && value.role !== 2) throw new Error('Vai trò ghế không hợp lệ.');
  if (BigInt(value.committeeEpoch) < 0n || BigInt(value.deadline) <= BigInt(Math.floor(Date.now() / 1_000))) {
    throw new Error('Draft thay ghế đã hết hạn hoặc không hợp lệ.');
  }
  if (BigInt(value.chainId) <= 0n) throw new Error('Chain ID trong draft không hợp lệ.');

  const seenSigners = new Set<string>();
  const signatures = value.signatures.map(signature => {
    if (!isAddress(signature.signer) || !/^0x[0-9a-f]+$/i.test(signature.signature) || BigInt(signature.nonce) < 0n || BigInt(signature.deadline) !== BigInt(value.deadline)) {
      throw new Error('Chữ ký trong draft không hợp lệ.');
    }
    const signer = getAddress(signature.signer);
    if (seenSigners.has(signer.toLowerCase())) throw new Error('Draft chứa chữ ký trùng người ký.');
    seenSigners.add(signer.toLowerCase());
    return { ...signature, signer };
  });

  return {
    ...value,
    oldSeat: getAddress(value.oldSeat),
    newSeat: getAddress(value.newSeat),
    signatures
  };
}

/** Đọc epoch và block time từ RPC đã cấu hình để mọi người ký cùng một nội dung có hạn dùng rõ ràng. */
export async function createCommitteeSeatChangeDraft(input: {
  contractAddress: string;
  rpcUrl: string;
  oldSeat: string;
  newSeat: string;
  role: CommitteeSeatRoleCode;
}): Promise<CommitteeSeatChangeDraft> {
  if (!isAddress(input.contractAddress) || !input.rpcUrl.trim()) throw new Error('Thiếu cấu hình CommitteeGovernance hoặc RPC.');
  const provider = new JsonRpcProvider(input.rpcUrl);
  const contract = new Contract(getAddress(input.contractAddress), committeeSeatChangeAbi, provider);
  const [network, epoch, block] = await Promise.all([provider.getNetwork(), contract.committeeEpoch(), provider.getBlock('latest')]);
  if (!block) throw new Error('Không đọc được block hiện tại để tạo hạn ký.');
  return normalizeDraft({
    oldSeat: input.oldSeat,
    newSeat: input.newSeat,
    role: input.role,
    committeeEpoch: BigInt(epoch).toString(),
    deadline: (BigInt(block.timestamp) + 60n * 60n).toString(),
    chainId: network.chainId.toString(),
    signatures: []
  });
}

/** Lấy nonce chưa dùng trong bitmap của ví để không tái sử dụng nonce giữa vote và thao tác thay ghế. */
async function findAvailableNonce(contract: Contract, signer: string): Promise<bigint> {
  for (let wordPosition = 0n; wordPosition < 64n; wordPosition += 1n) {
    const bitmap = BigInt(await contract.nonceBitmap(signer, wordPosition));
    for (let bit = 0n; bit < 256n; bit += 1n) {
      if ((bitmap & (1n << bit)) === 0n) return wordPosition * 256n + bit;
    }
  }
  throw new Error('Không còn nonce trống trong vùng quét an toàn; cần công cụ vận hành xử lý.');
}

/** Kết nối ví, kiểm tra đúng chain của draft và trả về signer; không tự đổi domain theo mạng ví hiện tại. */
async function getChainSigner(chainId: string): Promise<{ provider: BrowserProvider; signer: Awaited<ReturnType<BrowserProvider['getSigner']>> }> {
  const ethereum = (window as EthereumBrowserWindow).ethereum;
  if (!ethereum) throw new Error('Không tìm thấy MetaMask hoặc ví EVM tương thích.');
  const provider = new BrowserProvider(ethereum);
  await provider.send('eth_requestAccounts', []);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(chainId)) throw new Error(`Ví đang ở sai mạng. Vui lòng chuyển sang chain ID ${chainId}.`);
  return { provider, signer: await provider.getSigner() };
}

async function getDraftSigner(draft: CommitteeSeatChangeDraft): Promise<{ provider: BrowserProvider; signer: Awaited<ReturnType<BrowserProvider['getSigner']>> }> {
  return getChainSigner(draft.chainId);
}

/** Thêm chữ ký của ví hiện tại vào draft, luôn kiểm tra epoch chain trước khi hiện popup ký. */
export async function signCommitteeSeatChangeDraft(input: {
  contractAddress: string;
  draft: CommitteeSeatChangeDraft;
}): Promise<CommitteeSeatChangeSignature> {
  const draft = normalizeDraft(input.draft);
  const { signer } = await getDraftSigner(draft);
  const signerAddress = getAddress(await signer.getAddress());
  if (draft.signatures.some(item => item.signer.toLowerCase() === signerAddress.toLowerCase())) throw new Error('Ví này đã ký draft.');
  const contract = new Contract(getAddress(input.contractAddress), committeeSeatChangeAbi, signer);
  if (BigInt(await contract.committeeEpoch()) !== BigInt(draft.committeeEpoch)) throw new Error('Roster đã thay đổi; hãy tạo draft mới trước khi ký.');
  const nonce = await findAvailableNonce(contract, signerAddress);
  const signature = await signer.signTypedData(
    { name: 'CommitteeGovernance', version: '1', chainId: BigInt(draft.chainId), verifyingContract: getAddress(input.contractAddress) },
    seatChangeTypes,
    {
      oldSeat: draft.oldSeat,
      newSeat: draft.newSeat,
      role: draft.role,
      committeeEpoch: BigInt(draft.committeeEpoch),
      nonce,
      deadline: BigInt(draft.deadline)
    }
  );
  return { signer: signerAddress, nonce: nonce.toString(), deadline: draft.deadline, signature };
}

/** Gửi đề xuất sau khi có ít nhất ba chữ ký hợp lệ; relayer không sở hữu quyền thay ghế. */
export async function submitCommitteeSeatChangeProposal(input: {
  contractAddress: string;
  draft: CommitteeSeatChangeDraft;
}): Promise<string> {
  const draft = normalizeDraft(input.draft);
  if (draft.signatures.length < 3) throw new Error('Cần ít nhất ba chữ ký ghế hiện hữu trước khi đề xuất.');
  const { signer } = await getDraftSigner(draft);
  const contract = new Contract(getAddress(input.contractAddress), committeeSeatChangeAbi, signer);
  const transaction = await contract.proposeSeatChange(draft.oldSeat, draft.newSeat, draft.role, draft.signatures);
  await transaction.wait();
  return transaction.hash as string;
}

/** Thực thi proposal đã qua timelock; backend projector sẽ đồng bộ roster từ event SeatChangeExecuted. */
export async function executeCommitteeSeatChangeProposal(input: {
  contractAddress: string;
  chainId: string;
  proposalId: string;
}): Promise<string> {
  if (!/^\d+$/.test(input.proposalId) || BigInt(input.proposalId) <= 0n) throw new Error('Mã proposal không hợp lệ.');
  const { signer } = await getChainSigner(input.chainId);
  const contract = new Contract(getAddress(input.contractAddress), committeeSeatChangeAbi, signer);
  const transaction = await contract.executeSeatChange(BigInt(input.proposalId));
  await transaction.wait();
  return transaction.hash as string;
}

/** Parse draft chia sẻ giữa các signer nhưng không tin JSON bên ngoài trước khi chuẩn hóa đầy đủ. */
export function parseCommitteeSeatChangeDraft(serializedDraft: string): CommitteeSeatChangeDraft {
  try {
    return normalizeDraft(JSON.parse(serializedDraft) as CommitteeSeatChangeDraft);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Draft thay ghế không hợp lệ.');
  }
}
