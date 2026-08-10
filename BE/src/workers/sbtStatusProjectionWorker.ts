import { ethers } from 'ethers';
import {
  getImpactSbtContractAddressLowercase,
  getReadOnlyImpactSbtContract,
  getReadOnlyImpactSbtProvider
} from '../config/sbtContract';
import { getLogger } from '../config/logger';
import { SBT_MINT_CONFIRMATION_BLOCKS } from '../constants/sbtMint';
import { toSbtTokenStatusName } from '../constants/sbtTokenStatus';
import { findEarliestConfirmedImpactSbtBlock } from '../models/impactSbtMetadataModel';
import {
  findPendingSbtStatusProjectionEvents,
  findSbtStatusProjectionCheckpoint,
  saveSbtStatusProjectionCheckpoint,
  type SbtStatusProjectionCheckpointRecord,
  type SbtStatusProjectionScope
} from '../models/sbtStatusProjectionModel';
import { projectSbtTokenStatusUpdate } from '../services/sbtStatusProjectionService';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import { withRpcTimeout } from '../utils/withRpcTimeout';

const logger = getLogger();
const SBT_STATUS_PROJECTION_INTERVAL_MS = 15_000;
const SBT_STATUS_PROJECTION_MAX_BLOCKS_PER_REQUEST = 2_000;
const SBT_STATUS_PROJECTION_MAX_BLOCKS_PER_CYCLE = 10_000;
// getLogs quét cả chunk block nên cần thời gian riêng, không dùng timeout 5 giây của RPC read đơn lẻ.
const SBT_STATUS_PROJECTION_LOGS_TIMEOUT_MS = 30_000;
const SBT_STATUS_PROJECTION_CONFIRMATION_BLOCKS = Math.max(SBT_MINT_CONFIRMATION_BLOCKS, 12);
const SBT_STATUS_PROJECTION_PENDING_BATCH_SIZE = 200;
const LAST_LOG_INDEX_IN_BLOCK = Number.MAX_SAFE_INTEGER;
let projectionTimer: ReturnType<typeof setInterval> | null = null;
let isProjectionRunning = false;

/** Kiểm tra log có nằm sau checkpoint hiện tại để replay block dở dang mà không xử lý lại event cũ. */
function isLogAfterCheckpoint(log: ethers.Log, checkpoint: SbtStatusProjectionCheckpointRecord): boolean {
  return log.blockNumber > checkpoint.lastProcessedBlock
    || (log.blockNumber === checkpoint.lastProcessedBlock && log.index > checkpoint.lastProcessedLogIndex);
}

/** Tạo checkpoint tạm từ mint block cũ nhất, không ghi sentinel khi gallery chưa có dữ liệu. */
async function createInitialCheckpoint(
  scope: SbtStatusProjectionScope
): Promise<SbtStatusProjectionCheckpointRecord | null> {
  const earliestMintBlock = await findEarliestConfirmedImpactSbtBlock();
  if (earliestMintBlock === null) {
    return null;
  }

  return {
    ...scope,
    lastProcessedBlock: Math.max(0, earliestMintBlock),
    lastProcessedLogIndex: -1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/** Parse TokenStatusUpdated thành payload typed và từ chối enum/tokenId bất thường trước khi ghi Mongo. */
function parseSbtTokenStatusUpdatedLog(
  contract: ethers.Contract,
  log: ethers.Log,
  scope: SbtStatusProjectionScope
) {
  const parsedLog = contract.interface.parseLog({ topics: log.topics, data: log.data });
  if (!parsedLog || parsedLog.name !== 'TokenStatusUpdated') {
    throw new Error('Không thể parse TokenStatusUpdated log.');
  }

  const tokenId = Number(parsedLog.args.tokenId);
  const newStatusValue = Number(parsedLog.args.newStatus);
  const newStatus = toSbtTokenStatusName(newStatusValue);
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || !newStatus) {
    throw new Error('TokenStatusUpdated chứa tokenId hoặc status không hợp lệ.');
  }
  if (!log.transactionHash || !log.blockHash || !Number.isSafeInteger(log.index) || log.index < 0) {
    throw new Error('TokenStatusUpdated thiếu định danh log canonical.');
  }

  return {
    ...scope,
    transactionHash: log.transactionHash,
    logIndex: log.index,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    tokenId,
    newStatus,
    // Lý do từ chain là input không tin cậy; sanitize trước khi đưa vào read model.
    reason: sanitizeProviderError(String(parsedLog.args.reason)) ?? ''
  };
}

/** Retry event PENDING đã đến hạn theo batch để metadata đến muộn không làm kẹt checkpoint log mới. */
async function reconcilePendingSbtTokenStatusEvents(scope: SbtStatusProjectionScope): Promise<void> {
  const pendingEvents = await findPendingSbtStatusProjectionEvents(scope, SBT_STATUS_PROJECTION_PENDING_BATCH_SIZE);
  for (const pendingEvent of pendingEvents) {
    // Atomic event location ở model metadata vẫn ngăn event cũ ghi đè trạng thái canonical mới hơn.
    await projectSbtTokenStatusUpdate(pendingEvent);
  }
}

/** Reconcile TokenStatusUpdated đã đủ confirmation vào Mongo, checkpoint theo chunk để restart không bỏ log. */
export async function reconcileSbtTokenStatusProjection(): Promise<void> {
  if (isProjectionRunning) return;
  isProjectionRunning = true;

  try {
    const provider = getReadOnlyImpactSbtProvider();
    const contract = getReadOnlyImpactSbtContract();
    const [network, currentBlock] = await Promise.all([
      withRpcTimeout(provider.getNetwork()),
      withRpcTimeout(provider.getBlockNumber())
    ]);
    const finalizedBlock = currentBlock - SBT_STATUS_PROJECTION_CONFIRMATION_BLOCKS;
    if (finalizedBlock < 0) return;

    const scope: SbtStatusProjectionScope = {
      chainId: network.chainId.toString(),
      contractAddress: getImpactSbtContractAddressLowercase()
    };
    await reconcilePendingSbtTokenStatusEvents(scope);
    const existingCheckpoint = await findSbtStatusProjectionCheckpoint(scope);
    const checkpoint = existingCheckpoint ?? await createInitialCheckpoint(scope);
    if (!checkpoint) return;
    if (
      checkpoint.lastProcessedBlock > finalizedBlock
      || (checkpoint.lastProcessedBlock === finalizedBlock
        && checkpoint.lastProcessedLogIndex >= LAST_LOG_INDEX_IN_BLOCK)
    ) {
      return;
    }

    const eventFragment = contract.interface.getEvent('TokenStatusUpdated');
    if (!eventFragment) {
      throw new Error('ABI ImpactSBT thiếu event TokenStatusUpdated.');
    }

    const lastBlockInCycle = Math.min(
      finalizedBlock,
      checkpoint.lastProcessedBlock + SBT_STATUS_PROJECTION_MAX_BLOCKS_PER_CYCLE - 1
    );
    for (
      let chunkStart = checkpoint.lastProcessedBlock;
      chunkStart <= lastBlockInCycle;
      chunkStart += SBT_STATUS_PROJECTION_MAX_BLOCKS_PER_REQUEST
    ) {
      const chunkEnd = Math.min(
        chunkStart + SBT_STATUS_PROJECTION_MAX_BLOCKS_PER_REQUEST - 1,
        lastBlockInCycle
      );
      const logs = await withRpcTimeout(
        provider.getLogs({
          address: scope.contractAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [eventFragment.topicHash]
        }),
        SBT_STATUS_PROJECTION_LOGS_TIMEOUT_MS
      );
      const sortedLogs = logs.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);

      for (const log of sortedLogs) {
        if (!isLogAfterCheckpoint(log, checkpoint)) continue;

        let parsedEvent: ReturnType<typeof parseSbtTokenStatusUpdatedLog>;
        try {
          parsedEvent = parseSbtTokenStatusUpdatedLog(contract, log, scope);
        } catch (error) {
          // Một log hỏng không được phép chặn các log hợp lệ phía sau trong cùng chunk.
          logger.error('Bỏ qua TokenStatusUpdated log không thể parse.', {
            transactionHash: log.transactionHash ?? 'UNKNOWN_HASH',
            blockNumber: log.blockNumber,
            logIndex: log.index,
            errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
          });
          continue;
        }

        await projectSbtTokenStatusUpdate(parsedEvent);
      }

      // Log đã durable dù metadata chưa sẵn sàng; checkpoint vẫn tiến để không chặn event phía sau.
      await saveSbtStatusProjectionCheckpoint(scope, chunkEnd, LAST_LOG_INDEX_IN_BLOCK);
    }
  } catch (error) {
    logger.error('SBT status projector reconcile thất bại.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  } finally {
    isProjectionRunning = false;
  }
}

/** Khởi động polling projector với confirmation depth để không ghi state từ block chưa final. */
export function startSbtStatusProjectionWorker(): void {
  if (projectionTimer) return;

  void reconcileSbtTokenStatusProjection();
  projectionTimer = setInterval(() => {
    void reconcileSbtTokenStatusProjection();
  }, SBT_STATUS_PROJECTION_INTERVAL_MS);
  logger.info('SBT status projection worker đã khởi động.', {
    intervalMs: SBT_STATUS_PROJECTION_INTERVAL_MS,
    confirmationBlocks: SBT_STATUS_PROJECTION_CONFIRMATION_BLOCKS
  });
}

/** Dừng polling projector để graceful shutdown không giữ event loop của process. */
export function stopSbtStatusProjectionWorker(): void {
  if (!projectionTimer) return;
  clearInterval(projectionTimer);
  projectionTimer = null;
}

/** Reset state module chỉ dành cho test isolated của worker. */
export function __resetSbtStatusProjectionWorkerState(): void {
  stopSbtStatusProjectionWorker();
  isProjectionRunning = false;
}
