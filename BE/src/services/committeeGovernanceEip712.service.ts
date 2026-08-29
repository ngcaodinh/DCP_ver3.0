import { randomBytes } from 'crypto';
import { Contract, JsonRpcProvider, TypedDataEncoder, getAddress, isAddress, keccak256, toUtf8Bytes, verifyTypedData, type TypedDataField } from 'ethers';
import { getBlockchainRpcUrl } from '../config/blockchainRpc';
import {
  consumeCommitteeVoteSigningRequest,
  createCommitteeVoteSigningRequest,
  findCommitteeVoteSigningRequest
} from '../models/committeeVoteSigningRequestModel';
import { ApplicationError } from '../utils/applicationError';

export type CommitteeDecisionKind = 'DISBURSEMENT' | 'ARBITRATION';
export type CommitteeVoteDecision = 'APPROVE' | 'REJECT' | 'UPHOLD_PROJECT' | 'REJECT_PROJECT';

const COMMITTEE_GOVERNANCE_READ_ABI = [
  'function committeeEpoch() view returns (uint64)',
  'function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)'
];
const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const VOTE_TYPES: Record<string, TypedDataField[]> = {
  Vote: [
    { name: 'kind', type: 'uint8' },
    { name: 'subjectId', type: 'bytes32' },
    { name: 'approved', type: 'bool' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'committeeEpoch', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

export interface CommitteeVoteSignaturePayload {
  signingRequestId: string;
  domain: { name: 'CommitteeGovernance'; version: '1'; chainId: number; verifyingContract: string };
  types: Record<string, TypedDataField[]>;
  value: {
    kind: number;
    subjectId: string;
    approved: boolean;
    reasonHash: string;
    committeeEpoch: string;
    nonce: string;
    deadline: string;
  };
}

export interface SubmittedCommitteeVoteSignature {
  signature: string;
  signingRequestId: string;
}

const RELAY_SIGNATURE_GRACE_SECONDS = 24 * 60 * 60;

/** Đọc cấu hình on-chain, chỉ cho phép unit test nghiệp vụ thuần chạy không RPC để staging không thể nhận phiếu không chữ ký. */
async function getCommitteeGovernanceConfig(): Promise<{ provider: JsonRpcProvider; contractAddress: string; chainId: number } | null> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  const rpcUrl = getBlockchainRpcUrl();
  if (!isAddress(contractAddress) || !rpcUrl) {
    if (process.env.NODE_ENV === 'test') return null;
    throw new ApplicationError('Thiếu cấu hình CommitteeGovernance để xác minh chữ ký EIP-712.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  return { provider, contractAddress: getAddress(contractAddress), chainId: Number(network.chainId) };
}

/** Đọc epoch hiện tại từ CommitteeGovernance và fail-closed khi không thể đối soát blockchain. */
export async function readCommitteeEpochFromChain(): Promise<string> {
  try {
    const config = await getCommitteeGovernanceConfig();
    if (!config) {
      throw new ApplicationError('Không thể đọc epoch Ủy ban trên blockchain để đối soát phán quyết.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    const contract = new Contract(config.contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, config.provider);
    return (await contract.committeeEpoch() as bigint).toString();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('Không thể đọc epoch Ủy ban trên blockchain. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

export function getCommitteeDecisionSubjectId(kind: CommitteeDecisionKind, businessId: string): string {
  return keccak256(toUtf8Bytes(`DCP:${kind}:${businessId}`));
}

/** Hash lý do canonical chung cho mọi signer, còn lý do riêng từng người nằm trong audit/vote record bất biến. */
export function getCommitteeDecisionReasonHash(kind: CommitteeDecisionKind, businessId: string, approved: boolean): string {
  return keccak256(toUtf8Bytes(`DCP Committee ${kind} decision ${businessId}: ${approved ? 'APPROVED' : 'REJECTED'}. Individual voter rationales are committed in the DCP audit record.`));
}

function toContractDecisionKind(kind: CommitteeDecisionKind): number {
  return kind === 'DISBURSEMENT' ? 0 : 1;
}

function isApprovedDecision(decision: CommitteeVoteDecision): boolean {
  return decision === 'APPROVE' || decision === 'UPHOLD_PROJECT';
}

/** Tạo payload ngắn hạn ở server để frontend không tự chọn epoch/domain/subject và không thể ký sai chain. */
export async function prepareCommitteeVoteSignature(
  kind: CommitteeDecisionKind,
  businessId: string,
  decision: CommitteeVoteDecision,
  voterUserId: string,
  reason: string,
  caseDeadlineAt: Date
): Promise<CommitteeVoteSignaturePayload | null> {
  const config = await getCommitteeGovernanceConfig();
  if (!config) return null;
  const contract = new Contract(config.contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, config.provider);
  const committeeEpoch = await contract.committeeEpoch() as bigint;
  const approved = isApprovedDecision(decision);
  const subjectId = getCommitteeDecisionSubjectId(kind, businessId);
  const reasonHash = getCommitteeDecisionReasonHash(kind, businessId, approved);
  const reasonCommitment = keccak256(toUtf8Bytes(reason.trim()));
  // Nonce mang commitment của lý do trong audit request để chữ ký luôn gắn đúng nội dung người dùng đã xem.
  const nonce = BigInt(keccak256(toUtf8Bytes(`${reasonCommitment}:${randomBytes(32).toString('hex')}`)));
  const deadline = BigInt(Math.floor(Math.max(caseDeadlineAt.getTime(), Date.now()) / 1000) + RELAY_SIGNATURE_GRACE_SECONDS);
  const signingRequest = await createCommitteeVoteSigningRequest({
    kind,
    businessId,
    voterUserId,
    decision,
    reasonCommitment,
    committeeEpoch: committeeEpoch.toString(),
    nonce: nonce.toString(),
    deadline: new Date(Number(deadline) * 1000)
  });
  return {
    signingRequestId: signingRequest.signingRequestId,
    domain: { name: 'CommitteeGovernance', version: '1', chainId: config.chainId, verifyingContract: config.contractAddress },
    types: VOTE_TYPES,
    value: {
      kind: toContractDecisionKind(kind), subjectId, approved, reasonHash,
      committeeEpoch: committeeEpoch.toString(), nonce: nonce.toString(), deadline: deadline.toString()
    }
  };
}

/** Xác minh chữ ký EOA trước khi ghi vote; smart-account ERC-1271 được kiểm tra read-only cùng digest. */
export async function verifyCommitteeVoteSignature(input: {
  kind: CommitteeDecisionKind;
  businessId: string;
  decision: CommitteeVoteDecision;
  expectedWalletAddress: string;
  voterUserId: string;
  reason: string;
  submitted: SubmittedCommitteeVoteSignature | undefined;
}): Promise<{ signature: string | null; signedPayloadHash: string | null; committeeEpoch: string | null; reasonCommitment: string | null; nonce: string | null; deadline: Date | null }> {
  const config = await getCommitteeGovernanceConfig();
  if (!config) return { signature: null, signedPayloadHash: null, committeeEpoch: null, reasonCommitment: null, nonce: null, deadline: null };
  if (!input.submitted?.signature || !input.submitted.signingRequestId) {
    throw new ApplicationError('Bắt buộc ký EIP-712 bằng ví ghế Ủy ban trước khi biểu quyết.', 400, 'VALIDATION_ERROR');
  }
  const signingRequest = await findCommitteeVoteSigningRequest(input.submitted.signingRequestId);
  if (!signingRequest || signingRequest.consumedAt || signingRequest.deadline <= new Date()) {
    throw new ApplicationError('Yêu cầu ký EIP-712 không tồn tại, đã được dùng hoặc đã hết hạn. Vui lòng ký lại.', 409, 'CONFLICT');
  }
  const approved = isApprovedDecision(input.decision);
  const expectedSubjectId = getCommitteeDecisionSubjectId(input.kind, input.businessId);
  const expectedReasonHash = getCommitteeDecisionReasonHash(input.kind, input.businessId, approved);
  const expectedReasonCommitment = keccak256(toUtf8Bytes(input.reason.trim()));
  const deadline = BigInt(Math.floor(signingRequest.deadline.getTime() / 1000));
  if (
    signingRequest.kind !== input.kind || signingRequest.businessId !== input.businessId
    || signingRequest.voterUserId !== input.voterUserId || signingRequest.decision !== input.decision
    || signingRequest.reasonCommitment !== expectedReasonCommitment
    || deadline <= BigInt(Math.floor(Date.now() / 1000))
  ) {
    throw new ApplicationError('Payload chữ ký EIP-712 không khớp quyết định hoặc đã hết hạn.', 400, 'VALIDATION_ERROR');
  }
  const nonce = BigInt(signingRequest.nonce);
  const committeeEpoch = BigInt(signingRequest.committeeEpoch);
  if (nonce < 0n || committeeEpoch < 1n) throw new ApplicationError('Nonce hoặc committee epoch trong chữ ký không hợp lệ.', 400, 'VALIDATION_ERROR');
  const currentEpoch = await new Contract(config.contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, config.provider).committeeEpoch() as bigint;
  if (currentEpoch !== committeeEpoch) throw new ApplicationError('Roster Ủy ban đã đổi; vui lòng tải lại và ký lại quyết định.', 409, 'CONFLICT');
  const domain = { name: 'CommitteeGovernance' as const, version: '1' as const, chainId: config.chainId, verifyingContract: config.contractAddress };
  const typedValue = { kind: toContractDecisionKind(input.kind), subjectId: expectedSubjectId, approved, reasonHash: expectedReasonHash, committeeEpoch, nonce, deadline };
  const signedPayloadHash = TypedDataEncoder.hash(domain, VOTE_TYPES, typedValue);
  const expectedWallet = getAddress(input.expectedWalletAddress);
  let isValid = false;
  try {
    isValid = getAddress(verifyTypedData(domain, VOTE_TYPES, typedValue, input.submitted.signature)) === expectedWallet;
  } catch {
    // ERC-1271 có thể không recover EOA; kiểm tra tiếp với contract wallet bên dưới.
  }
  if (!isValid) {
    try {
      const walletContract = new Contract(expectedWallet, COMMITTEE_GOVERNANCE_READ_ABI, config.provider);
      isValid = String(await walletContract.isValidSignature(signedPayloadHash, input.submitted.signature)).toLowerCase() === EIP1271_MAGIC_VALUE;
    } catch {
      isValid = false;
    }
  }
  if (!isValid) throw new ApplicationError('Chữ ký EIP-712 không thuộc ví ghế Ủy ban hiện tại.', 403, 'FORBIDDEN');
  if (!await consumeCommitteeVoteSigningRequest(signingRequest.signingRequestId)) {
    throw new ApplicationError('Yêu cầu ký EIP-712 đã được dùng hoặc hết hạn. Vui lòng ký lại.', 409, 'CONFLICT');
  }
  return {
    signature: input.submitted.signature,
    signedPayloadHash,
    committeeEpoch: committeeEpoch.toString(),
    reasonCommitment: signingRequest.reasonCommitment,
    nonce: nonce.toString(),
    deadline: new Date(Number(deadline) * 1000)
  };
}
