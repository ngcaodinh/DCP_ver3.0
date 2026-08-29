import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  findGovernanceSeatProjectionCheckpoint,
  saveGovernanceSeatProjectionCheckpoint
} from '../models/governanceSeatProjectionCheckpointModel';
import {
  upsertPublicCommitteeGovernanceEvent,
  type PublicCommitteeGovernanceEventType
} from '../models/publicCommitteeGovernanceEventModel';
import { reconcileGovernanceRosterFromChain } from '../services/governanceSeatService';

const logger = getLogger();
const POLL_INTERVAL_MS = 60_000;
const EVENT_SCAN_CHUNK_SIZE = 2_000;
const FINALITY_BLOCKS = 2;
const LAST_LOG_INDEX_IN_BLOCK = Number.MAX_SAFE_INTEGER;
const committeeGovernanceEventAbi = [
  'event SeatsBootstrapped(address[5] seats,uint8[5] roles)',
  'event DecisionRecorded(uint8 indexed kind,bytes32 indexed subjectId,bool approved,address[] voters,bytes32 reasonHash)',
  'event SeatChangeProposed(uint256 indexed proposalId,address indexed oldSeat,address indexed newSeat,address[] approvers,uint256 effectiveAt,uint256 expiresAt,uint64 committeeEpoch)',
  'event SeatChangeExecuted(uint256 indexed proposalId,address indexed oldSeat,address indexed newSeat)'
];

let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;

function getConfig(): { rpcUrl: string; contractAddress: string; deploymentBlock: number } | null {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  const deploymentBlock = Number(process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK);
  if (!rpcUrl || !ethers.isAddress(contractAddress) || !Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) return null;
  return { rpcUrl, contractAddress: contractAddress.toLowerCase(), deploymentBlock };
}

/** Chuẩn hóa event contract thành bản ghi công khai nhỏ, chỉ chứa dữ liệu có thể kiểm chứng từ chain. */
async function projectPublicCommitteeGovernanceEvent(
  provider: ethers.JsonRpcProvider,
  scope: { chainId: string; contractAddress: string },
  event: ethers.EventLog
): Promise<void> {
  const block = await provider.getBlock(event.blockNumber);
  if (!block) throw new Error('Không thể đọc block chứa event CommitteeGovernance.');
  const args = event.args as unknown as unknown[];
  let eventType: PublicCommitteeGovernanceEventType;
  let eventData: Record<string, unknown>;
  switch (event.fragment.name) {
    case 'SeatsBootstrapped':
      eventType = 'SEATS_BOOTSTRAPPED';
      eventData = { seats: Array.from(args[0] as string[]), roles: Array.from(args[1] as bigint[]).map(role => role.toString()) };
      break;
    case 'DecisionRecorded':
      eventType = 'DECISION_RECORDED';
      eventData = { kind: String(args[0]), subjectId: String(args[1]), approved: Boolean(args[2]), voters: Array.from(args[3] as string[]), reasonHash: String(args[4]) };
      break;
    case 'SeatChangeProposed':
      eventType = 'SEAT_CHANGE_PROPOSED';
      eventData = { proposalId: String(args[0]), oldSeat: String(args[1]), newSeat: String(args[2]), approvers: Array.from(args[3] as string[]), effectiveAt: String(args[4]), expiresAt: String(args[5]), committeeEpoch: String(args[6]) };
      break;
    case 'SeatChangeExecuted':
      eventType = 'SEAT_CHANGE_EXECUTED';
      eventData = { proposalId: String(args[0]), oldSeat: String(args[1]), newSeat: String(args[2]) };
      break;
    default:
      return;
  }
  await upsertPublicCommitteeGovernanceEvent({
    ...scope,
    transactionHash: event.transactionHash,
    blockNumber: event.blockNumber,
    logIndex: event.index,
    occurredAt: new Date(Number(block.timestamp) * 1_000),
    eventType,
    eventData
  });
}

/** Project SeatChangeExecuted sau finality nhỏ; projector đọc lại getSeats thay vì tin data event từng phần. */
async function runGovernanceSeatProjectionCycleInternal(): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const config = getConfig();
    if (!config) return;
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const [network, headBlock] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
    const finalizedBlock = headBlock - FINALITY_BLOCKS;
    if (finalizedBlock < config.deploymentBlock) return;
    const scope = { chainId: network.chainId.toString(), contractAddress: config.contractAddress };
    const checkpoint = await findGovernanceSeatProjectionCheckpoint(scope);
    const fromBlock = checkpoint ? checkpoint.lastProcessedBlock : config.deploymentBlock;
    if (fromBlock > finalizedBlock) return;
    const toBlock = Math.min(finalizedBlock, fromBlock + EVENT_SCAN_CHUNK_SIZE - 1);
    const contract = new ethers.Contract(config.contractAddress, committeeGovernanceEventAbi, provider);
    const events = (await Promise.all([
      contract.queryFilter(contract.filters.SeatsBootstrapped(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.DecisionRecorded(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.SeatChangeProposed(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.SeatChangeExecuted(), fromBlock, toBlock)
    ])).flat()
      .filter((event): event is ethers.EventLog => 'args' in event)
      .sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);
    for (const event of events) {
      if (checkpoint && (event.blockNumber < checkpoint.lastProcessedBlock || (event.blockNumber === checkpoint.lastProcessedBlock && event.index <= checkpoint.lastProcessedLogIndex))) continue;
      try {
        await projectPublicCommitteeGovernanceEvent(provider, scope, event);
        if (event.fragment.name === 'SeatChangeExecuted') await reconcileGovernanceRosterFromChain();
        await saveGovernanceSeatProjectionCheckpoint(scope, event.blockNumber, event.index);
        logger.info('Đã project event CommitteeGovernance công khai.', {
          eventName: event.fragment.name,
          transactionHash: event.transactionHash
        });
      } catch (error) {
        logger.warn('Projector ghế ủy ban thất bại; giữ checkpoint để retry an toàn.', {
          transactionHash: event.transactionHash,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }
    await saveGovernanceSeatProjectionCheckpoint(scope, toBlock, LAST_LOG_INDEX_IN_BLOCK);
  } catch (error) {
    logger.warn('Không thể quét SeatChangeExecuted; sẽ retry ở chu kỳ sau.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  } finally {
    cycleInFlight = false;
  }
}

export function runGovernanceSeatProjectionCycle(): Promise<void> {
  return runWithWorkerContext('governance-seat-projection', runGovernanceSeatProjectionCycleInternal);
}

export function startGovernanceSeatProjectionWorker(): void {
  if (intervalId) return;
  void runGovernanceSeatProjectionCycle();
  intervalId = setInterval(() => { void runGovernanceSeatProjectionCycle(); }, POLL_INTERVAL_MS);
  intervalId.unref?.();
}

export function stopGovernanceSeatProjectionWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
