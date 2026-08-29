import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { findDisbursementByRequestId, appendDisbursementApprovalIfRoleAbsent, updateDisbursementByRequestId } from '../models/disbursementModel';
import {
  claimApprovedDisbursementCommitteeVote,
  completeDisbursementCommitteeExecution,
  findApprovedDisbursementCommitteeVotes,
  releaseDisbursementCommitteeExecution,
  renewDisbursementCommitteeExecutionLease,
  type DisbursementCommitteeVoteRecord
} from '../models/disbursementCommitteeVoteModel';
import {
  claimTechnicalSignerExecutionLock,
  releaseTechnicalSignerExecutionLock,
  renewTechnicalSignerExecutionLock,
  type TechnicalSignerExecutionLock
} from '../models/technicalSignerExecutionLockModel';
import { triggerPayosTransferForApprovedDisbursement } from './payosTransferWorker';

const logger = getLogger();
const POLL_INTERVAL_MS = 30_000;
const EXECUTION_LEASE_MS = 5 * 60 * 1000;
const EXECUTION_LEASE_HEARTBEAT_MS = 60_000;
const SYSTEM_EXECUTOR_USER_ID = 'SYSTEM_EXECUTOR';
const multisigAbi = [
  'function getRequest(uint256 requestId) view returns (bool exists,uint256 requestIdValue,uint256 projectId,address beneficiaryAddress,uint256 amount,uint8 status,uint256 approvalCount,uint256 signedCount,uint256 createdAt,uint256 executedAt,uint256 cancelledAt,bool adminSigned,bool orgSigned,bool regulatorySigned,uint256 timeoutDeadline,uint256 maxWithdrawable,uint8 requestMode,uint256 requiredApprovals,bool adminRoleSignatureCollected,bool orgRoleSignatureCollected,bool regulatoryRoleSignatureCollected)',
  'function signRequest(uint256 requestId) external'
];

type TechnicalSigner = { signerRole: 'ADMIN_SIGNER' | 'ORG_SIGNER' | 'REGULATORY_SIGNER'; signedFieldIndex: number; privateKeyVariable: string };
type CommitteeExecutionOutcome = 'PAYOS_ENQUEUED' | 'PAYOS_ALREADY_SETTLED' | 'CHAIN_TERMINAL';
type LeaseGuard = () => Promise<void>;
const technicalSigners: TechnicalSigner[] = [
  { signerRole: 'ADMIN_SIGNER', signedFieldIndex: 18, privateKeyVariable: 'DISBURSEMENT_SERVICE_SIGNER_ADMIN_KEY' },
  { signerRole: 'ORG_SIGNER', signedFieldIndex: 19, privateKeyVariable: 'DISBURSEMENT_SERVICE_SIGNER_ORG_KEY' },
  { signerRole: 'REGULATORY_SIGNER', signedFieldIndex: 20, privateKeyVariable: 'DISBURSEMENT_SERVICE_SIGNER_REGULATORY_KEY' }
];

let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;

/** Xác định khi nào signer bắt buộc chờ DecisionRecorded để không tiêu retry vì tiền đề chưa hoàn tất. */
function requiresOnChainDecisionBeforeExecution(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER === 'true';
}

/** Đọc biến môi trường signer mà không đưa private key vào log hoặc exception detail. */
function getTechnicalSigner(privateKeyVariable: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  const privateKey = process.env[privateKeyVariable]?.trim();
  if (!privateKey) throw new Error(`Thiếu cấu hình ${privateKeyVariable}.`);
  return new ethers.Wallet(privateKey, provider);
}

/** Chuẩn hóa trạng thái enum contract sang status Mongo để đường PayOS hiện có nhận đúng trạng thái APPROVED. */
function mapOnChainStatus(status: number): 'PENDING' | 'APPROVED' | 'EXECUTING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' {
  return (['PENDING', 'PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const)[status] || 'PENDING';
}

/** Đọc snapshot request từ chain để mọi nhánh recovery dùng cùng source of truth. */
async function getOnChainRequestSnapshot(
  contractAddress: string,
  provider: ethers.JsonRpcProvider,
  onChainRequestId: number
): Promise<{ contract: ethers.Contract; rawRequest: Array<unknown>; status: ReturnType<typeof mapOnChainStatus>; requiredApprovals: number; timeoutDeadline: Date }> {
  const contract = new ethers.Contract(contractAddress, multisigAbi, provider);
  const rawRequest = await contract.getRequest(BigInt(onChainRequestId)) as unknown as Array<unknown>;
  return {
    contract,
    rawRequest,
    status: mapOnChainStatus(Number(rawRequest[5])),
    requiredApprovals: Number(rawRequest[17]),
    timeoutDeadline: new Date(Number(rawRequest[14]) * 1000)
  };
}

/** Xác nhận PayOS đã có job hoặc đã hoàn tất trước khi execution case được đóng. */
async function enqueuePayosAfterChainApproval(
  requestId: string,
  assertLeaseIsValid: LeaseGuard
): Promise<'PAYOS_ENQUEUED' | 'PAYOS_ALREADY_SETTLED'> {
  const current = await findDisbursementByRequestId(requestId);
  if (current?.status === 'COMPLETED' || current?.payosTransferStatus === 'SUCCESS') {
    return 'PAYOS_ALREADY_SETTLED';
  }

  await assertLeaseIsValid();
  const triggerResult = await triggerPayosTransferForApprovedDisbursement(requestId);
  if (triggerResult.enqueued) return 'PAYOS_ENQUEUED';

  const latest = await findDisbursementByRequestId(requestId);
  if (
    latest?.status === 'COMPLETED'
    || latest?.payosTransferStatus === 'SUCCESS'
    || latest?.payosTransferStatus === 'PROCESSING'
    || latest?.payosTransferStatus === 'MANUAL_REVIEW'
  ) {
    return latest.payosTransferStatus === 'SUCCESS' || latest.status === 'COMPLETED'
      ? 'PAYOS_ALREADY_SETTLED'
      : 'PAYOS_ENQUEUED';
  }
  throw new Error('Không thể enqueue PayOS sau khi request đã được chain phê duyệt.');
}

/** Đồng bộ chain APPROVED vào Mongo và bền vững enqueue PayOS để restart không làm kẹt tiền. */
async function reconcileApprovedChainRequest(
  requestId: string,
  requiredApprovals: number,
  timeoutDeadline: Date,
  assertLeaseIsValid: LeaseGuard
): Promise<'PAYOS_ENQUEUED' | 'PAYOS_ALREADY_SETTLED'> {
  await assertLeaseIsValid();
  await updateDisbursementByRequestId(requestId, {
    status: 'APPROVED',
    requiredApprovals,
    timeoutDeadline
  });
  return enqueuePayosAfterChainApproval(requestId, assertLeaseIsValid);
}

/** Xử lý request đã được Ủy ban duyệt với outcome tường minh cho recovery chain và PayOS. */
async function executeApprovedCommitteeRequest(
  requestId: string,
  assertLeaseIsValid: LeaseGuard,
  onChainDecisionRecorded: boolean
): Promise<CommitteeExecutionOutcome> {
  // Khi Phase 2 được bật, một quyết định Mongo chưa có DecisionRecorded không được phép kích hoạt ba ví kỹ thuật.
  if (requiresOnChainDecisionBeforeExecution() && !onChainDecisionRecorded) {
    throw new Error('Quyết định ủy ban chưa được ghi nhận DecisionRecorded trên chain.');
  }
  const record = await findDisbursementByRequestId(requestId);
  if (!record) throw new Error('Không tìm thấy disbursement Mongo để chấp hành quyết định Ủy ban.');
  if (record.status === 'COMPLETED' || record.payosTransferStatus === 'SUCCESS') return 'PAYOS_ALREADY_SETTLED';
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim();
  const contractAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim();
  if (!rpcUrl || !contractAddress) throw new Error('Thiếu BLOCKCHAIN_RPC_URL hoặc MULTISIG_DISBURSEMENT_ADDRESS.');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let snapshot = await getOnChainRequestSnapshot(contractAddress, provider, record.onChainRequestId);

  for (const technicalSigner of technicalSigners) {
    if (snapshot.status === 'APPROVED') {
      const payosOutcome = await reconcileApprovedChainRequest(record.requestId, snapshot.requiredApprovals, snapshot.timeoutDeadline, assertLeaseIsValid);
      return payosOutcome;
    }
    if (snapshot.status !== 'PENDING') {
      await assertLeaseIsValid();
      await updateDisbursementByRequestId(record.requestId, {
        status: snapshot.status,
        requiredApprovals: snapshot.requiredApprovals,
        timeoutDeadline: snapshot.timeoutDeadline
      });
      return 'CHAIN_TERMINAL';
    }
    if (Boolean(snapshot.rawRequest[technicalSigner.signedFieldIndex])) continue;
    const signer = getTechnicalSigner(technicalSigner.privateKeyVariable, provider);
    const writableContract = snapshot.contract.connect(signer);
    let transactionHash: string;
    try {
      await assertLeaseIsValid();
      // ABI runtime được khai báo cục bộ cho worker, nên ethers chỉ suy ra BaseContract và cần cast hẹp tại boundary này.
      const transaction = await (writableContract as unknown as {
        signRequest: (requestId: bigint) => Promise<ethers.ContractTransactionResponse>;
      }).signRequest(BigInt(record.onChainRequestId));
      const receipt = await transaction.wait();
      if (!receipt || receipt.status !== 1) throw new Error('Giao dịch ký ví kỹ thuật không thành công.');
      transactionHash = transaction.hash;
    } catch (error) {
      const errorMessage = String((error as Error).message || '').toLowerCase();
      if (errorMessage.includes('alreadysigned') || errorMessage.includes('rolealreadysigned')) {
        // Receipt không tồn tại ở nhánh signer cũ; đọc lại một lần để vòng kế tiếp không dùng snapshot stale.
        snapshot = await getOnChainRequestSnapshot(contractAddress, provider, record.onChainRequestId);
        continue;
      }
      throw error;
    }
    // Snapshot sau receipt cũng là đầu vào vòng kế tiếp, tránh đọc lại cùng trạng thái trước mỗi signer.
    snapshot = await getOnChainRequestSnapshot(contractAddress, provider, record.onChainRequestId);
    await assertLeaseIsValid();
    await appendDisbursementApprovalIfRoleAbsent(record.requestId, {
      signerRole: technicalSigner.signerRole,
      signerUserId: SYSTEM_EXECUTOR_USER_ID,
      signerAddress: await signer.getAddress(),
      transactionHash,
      signedAt: new Date(),
      comment: 'Chấp hành quyết định Ủy ban đã đạt 3/5.'
    }, snapshot.status, snapshot.requiredApprovals, snapshot.timeoutDeadline);
    if (snapshot.status === 'APPROVED') {
      const payosOutcome = await reconcileApprovedChainRequest(record.requestId, snapshot.requiredApprovals, snapshot.timeoutDeadline, assertLeaseIsValid);
      return payosOutcome;
    }
  }
  throw new Error('Ba signer kỹ thuật chưa đưa request tới trạng thái APPROVED trên chain.');
}

/** Tạo heartbeat giữ đồng thời lease case và lock signer trong lúc chờ receipt hoặc queue PayOS. */
function createExecutionLeaseGuard(
  claimedCase: DisbursementCommitteeVoteRecord,
  technicalLock: TechnicalSignerExecutionLock
): { assertLeaseIsValid: LeaseGuard; stop: () => void } {
  let leaseLost = false;
  let renewalInFlight = false;
  const renewLeases = async (): Promise<void> => {
    if (leaseLost || renewalInFlight || !claimedCase.executionLeaseId) return;
    renewalInFlight = true;
    try {
      const leaseExpiresAt = new Date(Date.now() + EXECUTION_LEASE_MS);
      const [caseRenewed, signerLockRenewed] = await Promise.all([
        renewDisbursementCommitteeExecutionLease(claimedCase.requestId, claimedCase.executionLeaseId, leaseExpiresAt),
        renewTechnicalSignerExecutionLock(technicalLock.leaseId || '', technicalLock.fencingToken, leaseExpiresAt)
      ]);
      if (!caseRenewed || !signerLockRenewed) leaseLost = true;
    } catch {
      // Fail-closed: không broadcast side effect mới khi không thể chứng minh còn sở hữu lease.
      leaseLost = true;
    } finally {
      renewalInFlight = false;
    }
  };
  const heartbeat = setInterval(() => { void renewLeases(); }, EXECUTION_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    assertLeaseIsValid: async (): Promise<void> => {
      if (leaseLost) throw new Error('Đã mất lease worker; dừng side effect để tránh signer race.');
      await renewLeases();
      if (leaseLost) throw new Error('Không thể gia hạn lease worker; dừng side effect để tránh signer race.');
    },
    stop: (): void => clearInterval(heartbeat)
  };
}

/** Chạy một chu kỳ bounded dưới distributed signer lock để private key không tranh nonce giữa các instance. */
async function runDisbursementOnChainSignerCycleInternal(): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const technicalLeaseId = randomUUID();
    const technicalLock = await claimTechnicalSignerExecutionLock(
      technicalLeaseId,
      new Date(Date.now() + EXECUTION_LEASE_MS)
    );
    if (!technicalLock || technicalLock.leaseId !== technicalLeaseId) return;
    const requiresOnChainDecision = requiresOnChainDecisionBeforeExecution();
    const approvedCases = await findApprovedDisbursementCommitteeVotes(20, requiresOnChainDecision);
    let claimedCount = 0;
    let failedCount = 0;
    try {
      for (const approvedCase of approvedCases) {
        const leaseId = randomUUID();
        const claimedCase = await claimApprovedDisbursementCommitteeVote(
          approvedCase.requestId,
          leaseId,
          new Date(Date.now() + EXECUTION_LEASE_MS),
          requiresOnChainDecision
        );
        if (!claimedCase) continue;
        claimedCount += 1;
        const leaseGuard = createExecutionLeaseGuard(claimedCase, technicalLock);
        try {
          const outcome = await executeApprovedCommitteeRequest(
            claimedCase.requestId,
            leaseGuard.assertLeaseIsValid,
            claimedCase.onChainDecisionStatus === 'RECORDED'
          );
          await leaseGuard.assertLeaseIsValid();
          await completeDisbursementCommitteeExecution(claimedCase.requestId, leaseId);
          logger.info('Đã chấp hành committee case với outcome tường minh.', { requestId: claimedCase.requestId, outcome });
        } catch (error) {
          failedCount += 1;
          const errorMessage = error instanceof Error ? error.message : String(error);
          await releaseDisbursementCommitteeExecution(claimedCase.requestId, leaseId, claimedCase.executionAttemptCount, errorMessage);
          logger.error('Worker ký giải ngân thất bại.', { requestId: claimedCase.requestId, errorMessage });
        } finally {
          leaseGuard.stop();
        }
      }
      logger.info('Đã hoàn tất chu kỳ chấp hành giải ngân của Ủy ban.', { context: { discovered: approvedCases.length, claimedCount, failedCount } });
    } finally {
      await releaseTechnicalSignerExecutionLock(technicalLeaseId, technicalLock.fencingToken);
    }
  } finally {
    cycleInFlight = false;
  }
}

/** Chạy công khai một chu kỳ để test worker không cần chờ interval. */
export function runDisbursementOnChainSignerCycle(): Promise<void> {
  return runWithWorkerContext('disbursement-onchain-signer', runDisbursementOnChainSignerCycleInternal);
}

/** Khởi động worker chấp hành sau vote 3/5, chạy ngay một lượt rồi tiếp tục polling. */
export function startDisbursementOnChainSignerWorker(): void {
  if (intervalId) return;
  void runDisbursementOnChainSignerCycle();
  intervalId = setInterval(() => { void runDisbursementOnChainSignerCycle(); }, POLL_INTERVAL_MS);
}

/** Dừng polling khi graceful shutdown, không hủy giao dịch đã broadcast. */
export function stopDisbursementOnChainSignerWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
