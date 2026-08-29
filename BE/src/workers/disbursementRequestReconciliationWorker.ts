import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  findRecoverableDisbursementCreationIntents,
  findRecoverableDisbursementIntentByEvidenceCid,
  markDisbursementCreationIntentConfirmed,
  markDisbursementCreationIntentError,
  type DisbursementCreationIntent
} from '../models/disbursementCreationIntentModel';
import { findPendingDisbursementsForCommitteeRecovery } from '../models/disbursementModel';
import {
  findDisbursementRequestProjectionCheckpoint,
  saveDisbursementRequestProjectionCheckpoint
} from '../models/disbursementRequestProjectionCheckpointModel';
import { findDisbursementCommitteeVoteByRequestId } from '../models/disbursementCommitteeVoteModel';
import { openDisbursementCommitteeCase } from '../services/disbursementCommitteeVoting.service';
import { materializeDisbursementCreationIntent, parseRequestCreatedEvent, type RequestCreatedEventData } from '../services/disbursementService';

const logger = getLogger();
const POLL_INTERVAL_MS = 60_000;
const MAX_RECOVERABLE_INTENTS_PER_CYCLE = 25;
const MAX_RECORDS_WITHOUT_CASE_PER_CYCLE = 25;
const EVENT_QUERY_BLOCKS_PER_CYCLE = 2_000;
const LAST_LOG_INDEX_IN_BLOCK = Number.MAX_SAFE_INTEGER;
const requestCreatedAbi = [
  'event RequestCreated(uint256 indexed requestId,uint256 indexed projectId,address indexed beneficiary,uint256 amount,string evidenceCid,uint256 createdAt,uint256 timeoutDeadline,uint8 requestMode,uint256 requiredApprovals,uint256 raisedRatioBpsAtCreation)'
];

let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;

/** Đọc deployment block tường minh, không đoán block 0 làm RPC public bị quét vô hạn. */
function getDeploymentBlock(): number | null {
  const value = Number(process.env.MULTISIG_DISBURSEMENT_DEPLOYMENT_BLOCK);
  return Number.isSafeInteger(value) && value >= 0 && (process.env.NODE_ENV !== 'production' || value > 0) ? value : null;
}

function getReconciliationChainConfig(): { rpcUrl: string; contractAddress: string } | null {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const contractAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim() || '';
  return rpcUrl && ethers.isAddress(contractAddress) ? { rpcUrl, contractAddress: contractAddress.toLowerCase() } : null;
}

/** Materialize idempotent intent sau receipt/event, giữ lỗi để cycle sau retry thay vì broadcast lại. */
async function materializeIntentFromEvent(intent: DisbursementCreationIntent, eventData: RequestCreatedEventData): Promise<void> {
  try {
    await markDisbursementCreationIntentConfirmed(intent.intentId, eventData.onChainRequestId, intent.transactionHash);
    await materializeDisbursementCreationIntent({ ...intent, onChainRequestId: eventData.onChainRequestId, status: 'CONFIRMED' }, eventData);
  } catch (error) {
    await markDisbursementCreationIntentError(intent.intentId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Đối soát intent biết transaction hash; receipt thành công được dựng lại record/case, không phát tx mới. */
async function recoverKnownIntents(provider: ethers.JsonRpcProvider): Promise<void> {
  const intents = await findRecoverableDisbursementCreationIntents(MAX_RECOVERABLE_INTENTS_PER_CYCLE);
  for (const intent of intents) {
    if (!intent.transactionHash) continue;
    try {
      const receipt = await provider.getTransactionReceipt(intent.transactionHash);
      if (!receipt) continue;
      if (receipt.status !== 1) {
        await markDisbursementCreationIntentError(intent.intentId, 'Transaction tạo request on-chain đã revert.');
        continue;
      }
      await materializeIntentFromEvent(intent, parseRequestCreatedEvent(receipt.logs));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await markDisbursementCreationIntentError(intent.intentId, errorMessage);
      logger.warn('Chưa thể recover intent giải ngân từ receipt.', { intentId: intent.intentId, errorMessage });
    }
  }
}

/** Project RequestCreated theo checkpoint; event mồ côi chỉ được materialize khi CID ghép được intent server tạo trước tx. */
async function projectRequestCreatedEvents(provider: ethers.JsonRpcProvider, contractAddress: string): Promise<void> {
  const deploymentBlock = getDeploymentBlock();
  if (deploymentBlock === null) return;
  const [network, latestBlock] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  const scope = { chainId: network.chainId.toString(), contractAddress };
  const checkpoint = await findDisbursementRequestProjectionCheckpoint(scope);
  const fromBlock = checkpoint ? checkpoint.lastProcessedBlock : deploymentBlock;
  if (fromBlock > latestBlock) return;
  const toBlock = Math.min(latestBlock, fromBlock + EVENT_QUERY_BLOCKS_PER_CYCLE - 1);
  const contract = new ethers.Contract(contractAddress, requestCreatedAbi, provider);
  const logs = (await contract.queryFilter(contract.filters.RequestCreated(), fromBlock, toBlock))
    .filter((event): event is ethers.EventLog => 'args' in event);
  for (const event of logs.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index)) {
    if (checkpoint && (event.blockNumber < checkpoint.lastProcessedBlock || (event.blockNumber === checkpoint.lastProcessedBlock && event.index <= checkpoint.lastProcessedLogIndex))) continue;
    const args = event.args;
    const evidenceCid = String(args[4]);
    const intent = await findRecoverableDisbursementIntentByEvidenceCid(evidenceCid);
    if (!intent) {
      logger.error('Phát hiện RequestCreated không có intent recovery tương ứng; cần vận hành đối soát dữ liệu ngân hàng.', {
        transactionHash: event.transactionHash,
        onChainRequestId: String(args[0])
      });
      // Không chặn các event phía sau: request không có payload off-chain không thể tự dựng an toàn.
      await saveDisbursementRequestProjectionCheckpoint(scope, event.blockNumber, event.index);
      continue;
    }
    try {
      const eventData: RequestCreatedEventData = {
        onChainRequestId: Number(args[0]),
        createdAt: new Date(Number(args[5]) * 1000),
        timeoutDeadline: new Date(Number(args[6]) * 1000),
        requestMode: Number(args[7]) === 1 ? 'EMERGENCY' : 'NORMAL',
        requiredApprovals: Number(args[8]),
        raisedRatioBpsAtCreation: Number(args[9])
      };
      await materializeIntentFromEvent({ ...intent, transactionHash: intent.transactionHash || event.transactionHash }, eventData);
      await saveDisbursementRequestProjectionCheckpoint(scope, event.blockNumber, event.index);
    } catch (error) {
      logger.warn('Project RequestCreated thất bại; giữ checkpoint để retry an toàn.', {
        transactionHash: event.transactionHash,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }
  await saveDisbursementRequestProjectionCheckpoint(scope, toBlock, LAST_LOG_INDEX_IN_BLOCK);
}

/** Sửa nửa kia Mongo → case: record PENDING không có case được mở case snapshot một lần, worker ký vẫn fail-closed cho tới đó. */
async function recoverRecordsMissingCommitteeCase(): Promise<void> {
  const records = await findPendingDisbursementsForCommitteeRecovery(MAX_RECORDS_WITHOUT_CASE_PER_CYCLE);
  for (const record of records) {
    if (await findDisbursementCommitteeVoteByRequestId(record.requestId)) continue;
    try {
      await openDisbursementCommitteeCase(
        record.requestId,
        record.timeoutDeadline || new Date(record.createdAt.getTime() + (7 * 24 * 60 * 60 * 1000))
      );
    } catch (error) {
      logger.warn('Không thể khôi phục committee case còn thiếu.', {
        requestId: record.requestId,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function runReconciliationCycleInternal(): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const config = getReconciliationChainConfig();
    if (!config) return;
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    await recoverKnownIntents(provider);
    await projectRequestCreatedEvents(provider, config.contractAddress);
    await recoverRecordsMissingCommitteeCase();
  } catch (error) {
    logger.warn('Reconcile chain → Mongo → committee case thất bại; sẽ retry.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  } finally {
    cycleInFlight = false;
  }
}

/** Chạy một cycle public cho test/operational script mà không cần chờ interval. */
export function runDisbursementRequestReconciliationCycle(): Promise<void> {
  return runWithWorkerContext('disbursement-request-reconciliation', runReconciliationCycleInternal);
}

export function startDisbursementRequestReconciliationWorker(): void {
  if (intervalId) return;
  void runDisbursementRequestReconciliationCycle();
  intervalId = setInterval(() => { void runDisbursementRequestReconciliationCycle(); }, POLL_INTERVAL_MS);
}

export function stopDisbursementRequestReconciliationWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
