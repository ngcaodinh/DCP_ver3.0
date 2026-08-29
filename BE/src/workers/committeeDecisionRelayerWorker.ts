import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  deadLetterDisbursementCommitteeOnChainDecision,
  findResolvedDisbursementCommitteeVotesNeedingOnChainDecision,
  markDisbursementCommitteeDecisionNeedsResign,
  markDisbursementCommitteeDecisionRecorded,
  releaseDisbursementCommitteeOnChainDecision,
  type DisbursementCommitteeDecision,
  type DisbursementCommitteeVoteRecord
} from '../models/disbursementCommitteeVoteModel';
import {
  deadLetterProjectArbitrationOnChainDecision,
  findResolvedProjectArbitrationsNeedingOnChainDecision,
  markProjectArbitrationDecisionNeedsResign,
  markProjectArbitrationDecisionRecorded,
  releaseProjectArbitrationOnChainDecision,
  type ArbitrationVoteDecision,
  type ProjectArbitrationRecord
} from '../models/projectArbitrationModel';
import { getArbitrationTimeoutMs } from '../constants/projectListingPolicy';
import {
  claimTechnicalSignerExecutionLock,
  releaseTechnicalSignerExecutionLock,
  renewTechnicalSignerExecutionLock,
  type TechnicalSignerExecutionLock
} from '../models/technicalSignerExecutionLockModel';
import {
  getCommitteeDecisionReasonHash,
  getCommitteeDecisionSubjectId,
  type CommitteeDecisionKind
} from '../services/committeeGovernanceEip712.service';
import {
  selectCommitteeDecisionThresholdSignatures,
  type CommitteeDecisionRelayerSignature,
  type CommitteeDecisionSignatureSelection
} from '../services/committeeDecisionSignatureSelection.service';
import {
  createDisbursementCommitteeSnapshot,
  DISBURSEMENT_COMMITTEE_RESIGN_VOTING_WINDOW_MS,
  ensureExecutiveCommitteeRosterReady
} from '../services/disbursementCommitteeVoting.service';
import { createUserNotification } from '../services/notificationService';

const logger = getLogger();
const RELAYER_LOCK_NAME = 'committee-governance-decision-relayer';
const RELAYER_POLL_INTERVAL_MS = 30_000;
const RELAYER_LEASE_MS = 5 * 60 * 1000;
const RELAYER_HEARTBEAT_MS = 60_000;
const WAITING_SIGNATURES_DEAD_LETTER_DELAY_MS = 24 * 60 * 60 * 1000;
const COMMITTEE_GOVERNANCE_WRITE_ABI = [
  'function committeeEpoch() view returns (uint64)',
  'function decisionRecorded(bytes32 decisionKey) view returns (bool)',
  'function recordDecision(uint8 kind,bytes32 subjectId,bool approved,bytes32 reasonHash,(address signer,uint256 nonce,uint256 deadline,bytes signature)[] signatures)'
];

type RelayerCandidate = {
  kind: CommitteeDecisionKind;
  businessId: string;
  approved: boolean;
  signatureSelection: CommitteeDecisionSignatureSelection;
  onChainDecisionAttemptCount: number | undefined;
  onChainDecisionRecoveryCount: number | undefined;
  resolvedAt: Date | null;
  markRecorded: (transactionHash: string | null) => Promise<void>;
  markNeedsResign: (reason: string) => Promise<string[] | null>;
  deadLetterWaitingSignatures: (reason: string) => Promise<void>;
  releaseFailure: (attemptCount: number, errorMessage: string) => Promise<void>;
};
type RelayerConfig = {
  contract: ethers.Contract;
};

let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;

/** Chỉ cấu hình relayer bằng ví dịch vụ tách biệt; không dùng bất kỳ ví ghế ủy ban nào trên server. */
function getRelayerConfig(): RelayerConfig | null {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim();
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim();
  const privateKey = process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY?.trim();
  if (!rpcUrl || !contractAddress || !privateKey || !ethers.isAddress(contractAddress)) return null;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  return { contract: new ethers.Contract(ethers.getAddress(contractAddress), COMMITTEE_GOVERNANCE_WRITE_ABI, signer) };
}

/** Tạo candidate giải ngân và chỉ đọc roster mới khi cần mở round ký thay thế. */
function buildDisbursementCandidate(record: DisbursementCommitteeVoteRecord): RelayerCandidate {
  const winningDecision: DisbursementCommitteeDecision = record.status === 'APPROVED' ? 'APPROVE' : 'REJECT';
  return {
    kind: 'DISBURSEMENT',
    businessId: record.requestId,
    approved: record.status === 'APPROVED',
    signatureSelection: selectCommitteeDecisionThresholdSignatures(record.committeeSnapshot, record.votes, winningDecision),
    onChainDecisionAttemptCount: record.onChainDecisionAttemptCount,
    onChainDecisionRecoveryCount: undefined,
    resolvedAt: record.resolvedAt,
    markRecorded: transactionHash => markDisbursementCommitteeDecisionRecorded(record.requestId, transactionHash),
    markNeedsResign: async reason => {
      const committeeUsers = await ensureExecutiveCommitteeRosterReady();
      const committeeSnapshot = createDisbursementCommitteeSnapshot(committeeUsers);
      const reopened = await markDisbursementCommitteeDecisionNeedsResign(record.requestId, reason, {
        committeeSnapshot,
        deadlineAt: new Date(Date.now() + DISBURSEMENT_COMMITTEE_RESIGN_VOTING_WINDOW_MS)
      });
      return reopened ? committeeSnapshot.map(member => member.userId) : null;
    },
    deadLetterWaitingSignatures: reason => deadLetterDisbursementCommitteeOnChainDecision(record.requestId, reason),
    releaseFailure: (attemptCount, errorMessage) => releaseDisbursementCommitteeOnChainDecision(record.requestId, attemptCount, errorMessage)
  };
}

/** Tạo candidate xét xử và chỉ đọc roster mới khi cần mở lại vòng ký thay thế. */
function buildArbitrationCandidate(record: ProjectArbitrationRecord): RelayerCandidate | null {
  if (record.verdict !== 'UPHOLD_PROJECT' && record.verdict !== 'REJECT_PROJECT') return null;
  const winningDecision: ArbitrationVoteDecision = record.verdict;
  return {
    kind: 'ARBITRATION',
    businessId: record.arbitrationId,
    approved: record.verdict === 'UPHOLD_PROJECT',
    signatureSelection: selectCommitteeDecisionThresholdSignatures(record.committeeSnapshot, record.votes, winningDecision),
    onChainDecisionAttemptCount: record.onChainDecisionAttemptCount,
    onChainDecisionRecoveryCount: record.onChainDecisionRecoveryCount,
    resolvedAt: record.resolvedAt,
    markRecorded: transactionHash => markProjectArbitrationDecisionRecorded(record.arbitrationId, transactionHash),
    markNeedsResign: async reason => {
      const committeeUsers = await ensureExecutiveCommitteeRosterReady();
      const committeeSnapshot = committeeUsers.map(user => ({
        userId: user.id,
        role: user.role as 'executive_chair' | 'executive_member',
        fullName: user.fullName,
        walletAddress: user.walletAddress
      }));
      const reopened = await markProjectArbitrationDecisionNeedsResign(record.arbitrationId, reason, {
        committeeSnapshot,
        deadlineAt: new Date(Date.now() + getArbitrationTimeoutMs())
      });
      return reopened ? committeeSnapshot.map(member => member.userId) : null;
    },
    deadLetterWaitingSignatures: reason => deadLetterProjectArbitrationOnChainDecision(record.arbitrationId, reason),
    releaseFailure: (attemptCount, errorMessage) => releaseProjectArbitrationOnChainDecision(record.arbitrationId, attemptCount, errorMessage)
  };
}

function getDecisionKey(kind: CommitteeDecisionKind, subjectId: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'bytes32'], [kind === 'DISBURSEMENT' ? 0 : 1, subjectId]));
}

/** Gửi yêu cầu ký lại cho toàn bộ ghế snapshot mới sau khi transition nguyên tử đã hoàn tất. */
async function notifyCommitteeResignRequired(candidate: RelayerCandidate, voterUserIds: string[]): Promise<void> {
  const results = await Promise.allSettled(voterUserIds.map(userId => createUserNotification({
      userId,
      notificationType: 'COMMITTEE_RESIGN_REQUIRED',
      title: 'Cần ký lại quyết định Ủy ban',
      content: `Hồ sơ ${candidate.businessId} cần thu thập chữ ký mới vì epoch Ủy ban hoặc deadline chữ ký đã thay đổi. Bạn có thể bỏ phiếu lại theo roster hiện tại.`,
      metadata: { businessId: candidate.businessId, decisionKind: candidate.kind },
      channels: ['IN_APP'],
      priority: 'HIGH',
      enqueuedBy: 'system'
    })));
  if (results.some(result => result.status === 'rejected')) {
    logger.warn('Không thể gửi đủ thông báo cần ký lại hoặc cảnh báo vận hành; trạng thái hồ sơ vẫn đã được lưu an toàn.', {
      kind: candidate.kind,
      businessId: candidate.businessId
    });
  }
}

/** Gia hạn lock trước mỗi side effect; mất lock thì dừng, không được dùng private key của relayer thêm lần nào. */
function createRelayerLeaseGuard(lock: TechnicalSignerExecutionLock): { assertLeaseIsValid: () => Promise<void>; stop: () => void } {
  let leaseLost = false;
  let renewalInFlight = false;
  const renew = async (): Promise<void> => {
    if (leaseLost || renewalInFlight || !lock.leaseId) return;
    renewalInFlight = true;
    try {
      const renewed = await renewTechnicalSignerExecutionLock(
        lock.leaseId,
        lock.fencingToken,
        new Date(Date.now() + RELAYER_LEASE_MS),
        RELAYER_LOCK_NAME
      );
      if (!renewed) leaseLost = true;
    } catch {
      leaseLost = true;
    } finally {
      renewalInFlight = false;
    }
  };
  const heartbeat = setInterval(() => { void renew(); }, RELAYER_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    assertLeaseIsValid: async (): Promise<void> => {
      if (leaseLost) throw new Error('Đã mất lease relayer; dừng gửi giao dịch DecisionRecorded.');
      await renew();
      if (leaseLost) throw new Error('Không thể gia hạn lease relayer; dừng gửi giao dịch DecisionRecorded.');
    },
    stop: (): void => clearInterval(heartbeat)
  };
}

/** Ghi một kết quả đã chốt; kiểm tra mapping trước/sau lỗi để retry an toàn khi process chết sau broadcast. */
async function relayCandidate(
  config: RelayerConfig,
  candidate: RelayerCandidate,
  assertLeaseIsValid: () => Promise<void>
): Promise<'RECORDED' | 'ALREADY_RECORDED' | 'WAITING_SIGNATURES' | 'NEEDS_RESIGN'> {
  if (candidate.signatureSelection.status !== 'READY') return candidate.signatureSelection.status;
  const subjectId = getCommitteeDecisionSubjectId(candidate.kind, candidate.businessId);
  const decisionKey = getDecisionKey(candidate.kind, subjectId);
  const readContract = config.contract;
  if (await readContract.decisionRecorded(decisionKey) as boolean) {
    await candidate.markRecorded(null);
    return 'ALREADY_RECORDED';
  }
  const currentEpoch = await readContract.committeeEpoch() as bigint;
  if (currentEpoch.toString() !== candidate.signatureSelection.committeeEpoch) return 'NEEDS_RESIGN';
  const reasonHash = getCommitteeDecisionReasonHash(candidate.kind, candidate.businessId, candidate.approved);
  try {
    await assertLeaseIsValid();
    const transaction = await (config.contract as unknown as {
      recordDecision: (kind: number, subjectId: string, approved: boolean, reasonHash: string, signatures: CommitteeDecisionRelayerSignature[]) => Promise<ethers.ContractTransactionResponse>;
    }).recordDecision(candidate.kind === 'DISBURSEMENT' ? 0 : 1, subjectId, candidate.approved, reasonHash, candidate.signatureSelection.signatures);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Transaction DecisionRecorded không thành công.');
    await candidate.markRecorded(transaction.hash);
    return 'RECORDED';
  } catch (error) {
    // Một transaction có thể đã được mine nhưng response/receipt bị lỗi mạng; source of truth là mapping của contract.
    if (await readContract.decisionRecorded(decisionKey) as boolean) {
      await candidate.markRecorded(null);
      return 'ALREADY_RECORDED';
    }
    throw error;
  }
}

/** Xử lý một candidate theo trạng thái relay, chỉ thông báo sau khi transition ký lại đã hoàn tất. */
async function processCandidate(config: RelayerConfig, candidate: RelayerCandidate, assertLeaseIsValid: () => Promise<void>): Promise<void> {
  try {
    const outcome = await relayCandidate(config, candidate, assertLeaseIsValid);
    if (outcome === 'WAITING_SIGNATURES') {
      const hasWaitedTooLong = !candidate.resolvedAt
        || Date.now() - candidate.resolvedAt.getTime() >= WAITING_SIGNATURES_DEAD_LETTER_DELAY_MS;
      if (hasWaitedTooLong) {
        await candidate.deadLetterWaitingSignatures('Quyết định đã chốt quá 24 giờ nhưng không có đủ chữ ký EIP-712 cùng phía để ghi on-chain.');
        logger.error('Đã đưa quyết định không đủ chữ ký vào DLQ để không chặn hàng đợi relayer.', {
          kind: candidate.kind,
          businessId: candidate.businessId
        });
        return;
      }
      logger.warn('Quyết định đã chốt nhưng chưa có đủ chữ ký EIP-712 cùng phía để ghi on-chain.', {
        kind: candidate.kind,
        businessId: candidate.businessId
      });
      return;
    }
    if (outcome === 'NEEDS_RESIGN') {
      await assertLeaseIsValid();
      const voterUserIds = await candidate.markNeedsResign('Epoch Ủy ban hoặc deadline chữ ký đã thay đổi; cần thu thập chữ ký mới trước khi relay.');
      if (!voterUserIds) return;
      await assertLeaseIsValid();
      await notifyCommitteeResignRequired(candidate, voterUserIds);
      logger.warn('Quyết định cần ký lại trước khi relay để tránh giao dịch chắc chắn revert.', {
        kind: candidate.kind,
        businessId: candidate.businessId
      });
      return;
    }
    logger.info('Đã đối soát quyết định ủy ban với CommitteeGovernance.', {
      kind: candidate.kind,
      businessId: candidate.businessId,
      outcome
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const nextAttemptCount = Number(candidate.onChainDecisionAttemptCount || 0) + 1;
    await candidate.releaseFailure(nextAttemptCount, errorMessage);
    logger.error('Không thể relay quyết định ủy ban lên CommitteeGovernance; đã lên lịch retry hoặc DLQ.', {
      kind: candidate.kind,
      businessId: candidate.businessId,
      attemptCount: nextAttemptCount,
      errorMessage
    });
  }
}

async function runCommitteeDecisionRelayerCycleInternal(): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const config = getRelayerConfig();
    if (!config) return;
    const leaseId = randomUUID();
    const lock = await claimTechnicalSignerExecutionLock(leaseId, new Date(Date.now() + RELAYER_LEASE_MS), RELAYER_LOCK_NAME);
    if (!lock || lock.leaseId !== leaseId) return;
    const guard = createRelayerLeaseGuard(lock);
    try {
      const [disbursementCases, arbitrations] = await Promise.all([
        findResolvedDisbursementCommitteeVotesNeedingOnChainDecision(20),
        findResolvedProjectArbitrationsNeedingOnChainDecision(20)
      ]);
      for (const record of disbursementCases) {
        try {
          await processCandidate(config, buildDisbursementCandidate(record), guard.assertLeaseIsValid);
        } catch (error) {
          logger.error('Không thể relay quyết định giải ngân lên CommitteeGovernance.', {
            requestId: record.requestId,
            errorMessage: error instanceof Error ? error.message : String(error)
          });
        }
      }
      for (const record of arbitrations) {
        const candidate = buildArbitrationCandidate(record);
        if (!candidate) continue;
        try {
          await processCandidate(config, candidate, guard.assertLeaseIsValid);
        } catch (error) {
          logger.error('Không thể relay phán quyết dự án lên CommitteeGovernance.', {
            arbitrationId: record.arbitrationId,
            errorMessage: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      guard.stop();
      await releaseTechnicalSignerExecutionLock(leaseId, lock.fencingToken, RELAYER_LOCK_NAME);
    }
  } finally {
    cycleInFlight = false;
  }
}

/** Chạy một chu kỳ công khai cho test và job runner, không cần đợi interval. */
export function runCommitteeDecisionRelayerCycle(): Promise<void> {
  return runWithWorkerContext('committee-decision-relayer', runCommitteeDecisionRelayerCycleInternal);
}

/** Khởi động relayer idempotent; chỉ worker mới phát transaction, request API tuyệt đối không gọi contract ghi. */
export function startCommitteeDecisionRelayerWorker(): void {
  if (intervalId) return;
  void runCommitteeDecisionRelayerCycle();
  intervalId = setInterval(() => { void runCommitteeDecisionRelayerCycle(); }, RELAYER_POLL_INTERVAL_MS);
  intervalId.unref?.();
}

export function stopCommitteeDecisionRelayerWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
