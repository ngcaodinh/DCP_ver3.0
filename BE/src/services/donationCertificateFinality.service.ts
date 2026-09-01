import { ethers } from 'ethers';
import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import type { DonationCertificateFinalityMode, DonationCertificateSnapshot } from '../models/donationCertificateModel';
import { findUserById } from '../models/authModel';
import { findProjectByProjectId } from '../models/projectModel';

const DONATION_RECEIVED_ABI = ['event DonationReceived(address indexed donor, uint256 indexed projectId, uint256 amount, uint256 timestamp, bool isAnonymous)'];

export type DonationFinalityVerdict =
  | { status: 'PENDING'; finalityMode: DonationCertificateFinalityMode; currentConfirmations: number; finalizedBlockNumber: number | null }
  | { status: 'VERIFIED'; finalityMode: DonationCertificateFinalityMode; currentConfirmations: number; finalizedBlockNumber: number | null; snapshot: DonationCertificateSnapshot }
  | { status: 'REVOKED'; reasonCode: 'RECEIPT_MISSING' | 'RECEIPT_FAILED' | 'BLOCK_HASH_MISMATCH' | 'EVENT_MISMATCH' }
  | { status: 'UNAVAILABLE'; retryAfterMs: number; errorCode: 'RPC_TIMEOUT' | 'RPC_RATE_LIMITED' | 'RPC_UNAVAILABLE' }
  | { status: 'FINALIZED_TAG_UNSUPPORTED' }
  | { status: 'BLOCKED'; reasonCode: 'USER_NOT_FOUND' | 'PROJECT_NOT_FOUND' | 'ORGANIZATION_NOT_FOUND' | 'INVALID_CONFIGURATION' };

export interface DonationCertificateVerificationInput { transactionHash: string; donorUserId: string; expectedProjectId: string; expectedDonorAddress: string; expectedAmountRaw: string; expectedIsAnonymous: false; requestedMode: DonationCertificateFinalityMode; }

/** Phân loại lỗi RPC mà không coi lỗi timeout/rate-limit là finalized tag không hỗ trợ. */
function classifyRpcFailure(error: unknown): DonationFinalityVerdict['status'] | 'OTHER' {
  const candidate = error as { code?: unknown; message?: unknown; error?: { code?: unknown } };
  const code = candidate.code ?? candidate.error?.code;
  if (code === -32601 || code === -32602) return 'FINALIZED_TAG_UNSUPPORTED';
  const message = String(candidate.message ?? '').toLowerCase();
  if (message.includes('429') || message.includes('rate limit')) return 'UNAVAILABLE';
  return 'OTHER';
}

/** Tạo provider có kiểm tra chain trước khi tin dữ liệu receipt/event. */
async function getConfiguredProviders(): Promise<ethers.JsonRpcProvider[]> {
  const urls = [process.env.BLOCKCHAIN_RPC_URL, process.env.BLOCKCHAIN_RPC_FALLBACK_URL].map(value => String(value ?? '').trim()).filter(Boolean);
  if (!urls.length) throw new Error('Missing RPC URL');
  const config = getDonationCertificateConfig();
  const providers: ethers.JsonRpcProvider[] = [];
  for (const url of [...new Set(urls)]) {
    const provider = new ethers.JsonRpcProvider(url);
    const network = await provider.getNetwork();
    if (Number(network.chainId) === config.chainId) providers.push(provider);
  }
  if (!providers.length) throw new Error('Configured RPC does not match chain ID');
  return providers;
}

/** Xác minh receipt, event và finality để dựng snapshot bất biến từ canonical chain. */
export async function verifyDonationCertificateFinality(input: DonationCertificateVerificationInput): Promise<DonationFinalityVerdict> {
  let config: ReturnType<typeof getDonationCertificateConfig>;
  let providers: ethers.JsonRpcProvider[];
  try { config = getDonationCertificateConfig(); providers = await getConfiguredProviders(); } catch { return { status: 'BLOCKED', reasonCode: 'INVALID_CONFIGURATION' }; }
  let receipt: ethers.TransactionReceipt | null = null;
  let provider: ethers.JsonRpcProvider | null = null;
  let transientFailure: DonationFinalityVerdict | null = null;
  for (const candidate of providers) {
    try { receipt = await candidate.getTransactionReceipt(input.transactionHash); provider = candidate; break; }
    catch (error) { transientFailure = { status: 'UNAVAILABLE', retryAfterMs: config.pollIntervalMs, errorCode: classifyRpcFailure(error) === 'UNAVAILABLE' ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE' }; }
  }
  if (!receipt || !provider) return transientFailure ?? { status: 'REVOKED', reasonCode: 'RECEIPT_MISSING' };
  if (receipt.status !== 1) return { status: 'REVOKED', reasonCode: 'RECEIPT_FAILED' };
  try {
    const canonicalBlock = await provider.getBlock(receipt.blockNumber);
    if (!canonicalBlock || canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'REVOKED', reasonCode: 'BLOCK_HASH_MISMATCH' };
    const eventInterface = new ethers.Interface(DONATION_RECEIVED_ABI);
    const matches: Array<{ parsed: ethers.LogDescription; logIndex: number }> = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.donationContractAddress.toLowerCase()) continue;
      try {
        const parsed = eventInterface.parseLog(log);
        if (parsed?.name === 'DonationReceived' && String(parsed.args.projectId) === input.expectedProjectId && String(parsed.args.donor).toLowerCase() === input.expectedDonorAddress.toLowerCase()) matches.push({ parsed, logIndex: log.index });
      } catch { /* Log khác ABI không ảnh hưởng xác minh event cần tìm. */ }
    }
    if (matches.length !== 1) return { status: 'REVOKED', reasonCode: 'EVENT_MISMATCH' };
    const { parsed, logIndex } = matches[0];
    if (Boolean(parsed.args.isAnonymous) || String(parsed.args.amount) !== input.expectedAmountRaw) return { status: 'REVOKED', reasonCode: 'EVENT_MISMATCH' };
    const latestBlockNumber = await provider.getBlockNumber();
    const confirmations = Math.max(0, latestBlockNumber - receipt.blockNumber + 1);
    let finalizedBlockNumber: number | null = null;
    if (input.requestedMode === 'RPC_FINALIZED') {
      try {
        const finalizedBlock = await provider.send('eth_getBlockByNumber', ['finalized', false]) as { number?: string } | null;
        finalizedBlockNumber = finalizedBlock?.number ? Number(BigInt(finalizedBlock.number)) : null;
      } catch (error) {
        if (classifyRpcFailure(error) === 'FINALIZED_TAG_UNSUPPORTED') return { status: 'FINALIZED_TAG_UNSUPPORTED' };
        return { status: 'UNAVAILABLE', retryAfterMs: config.pollIntervalMs, errorCode: classifyRpcFailure(error) === 'UNAVAILABLE' ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE' };
      }
      if (finalizedBlockNumber === null || finalizedBlockNumber < receipt.blockNumber) return { status: 'PENDING', finalityMode: 'RPC_FINALIZED', currentConfirmations: confirmations, finalizedBlockNumber };
    } else if (confirmations < config.fallbackConfirmations) {
      return { status: 'PENDING', finalityMode: 'CONFIRMATION_FALLBACK', currentConfirmations: confirmations, finalizedBlockNumber: null };
    }
    // Chỉ đọc dữ liệu nghiệp vụ sau finality để poll PENDING không tạo tải Mongo lặp lại.
    const donor = await findUserById(input.donorUserId);
    if (!donor) return { status: 'BLOCKED', reasonCode: 'USER_NOT_FOUND' };
    if (String(donor.walletAddress).toLowerCase() !== input.expectedDonorAddress.toLowerCase()) return { status: 'REVOKED', reasonCode: 'EVENT_MISMATCH' };
    const project = await findProjectByProjectId(input.expectedProjectId);
    if (!project) return { status: 'BLOCKED', reasonCode: 'PROJECT_NOT_FOUND' };
    const organization = await findUserById(project.organizationId);
    if (!organization) return { status: 'BLOCKED', reasonCode: 'ORGANIZATION_NOT_FOUND' };
    const organizationName = String(organization.organizationName || organization.fullName || '').trim();
    if (!organizationName) return { status: 'BLOCKED', reasonCode: 'ORGANIZATION_NOT_FOUND' };
    return { status: 'VERIFIED', finalityMode: input.requestedMode, currentConfirmations: confirmations, finalizedBlockNumber, snapshot: { donorName: donor.fullName.trim(), donorAddress: input.expectedDonorAddress.toLowerCase(), projectId: project.projectId, projectName: project.name, organizationName, amountRaw: String(parsed.args.amount), tokenSymbol: 'DCT', tokenDecimals: 0, vndEquivalent: String(parsed.args.amount), valuationPolicy: 'POC_1_DCT_EQUALS_1_VND', donatedAt: new Date(Number(parsed.args.timestamp) * 1000), chainId: config.chainId, networkName: config.networkName, contractAddress: config.donationContractAddress.toLowerCase(), transactionHash: receipt.hash.toLowerCase(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase(), logIndex, finalityMode: input.requestedMode, confirmationsAtIssue: confirmations } };
  } catch (error) {
    return { status: 'UNAVAILABLE', retryAfterMs: config.pollIntervalMs, errorCode: classifyRpcFailure(error) === 'UNAVAILABLE' ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE' };
  }
}
