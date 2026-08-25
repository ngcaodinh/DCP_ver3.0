import { ethers } from 'ethers';
import {
  getAuditorStakingContractAddressLowercase,
  logAuditorStakingSignerAddressOnce,
  getReadOnlyAuditorStakingContract,
  getReadOnlyAuditorStakingProvider
} from '../config/auditorStakingContract';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  AUDITOR_STAKE_CONFIRMATION_BLOCKS,
  AUDITOR_STAKE_INTENT_TIMEOUT_MS,
  AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST,
  AUDITOR_STAKE_POLL_INTERVAL_MS,
  AUDITOR_STAKE_TIMEOUT_SWEEP_INTERVAL_MS
} from '../constants/auditorStaking';
import {
  findAuditorStakeEventCheckpoint,
  saveAuditorStakeEventCheckpoint,
  type AuditorStakeEventCheckpoint,
  type AuditorStakeEventCheckpointScope
} from '../models/auditorStakeEventCheckpointModel';
import {
  clearAuditorStakeEventProjectionFailure,
  markAuditorStakeEventAsDeadLetter,
  recordAuditorStakeEventProjectionFailure
} from '../models/auditorStakeEventDeadLetterModel';
import { findAuditorDebtSettlementById } from '../models/auditorDebtSettlementModel';
import {
  findExpiredAuditorStakeIntents,
  updateAuditorStakeIntent
} from '../models/auditorStakeIntentModel';
import { findUserById, findUserByWalletAddress } from '../models/authModel';
import { findAuditorStakeGuardByUserId, releaseAuditorUnstakeLock } from '../models/auditorStakeGuardModel';
import { findAuditorPayoutByOnchainTxHash, linkAuditorPayoutToOnchainWithdrawal } from '../models/auditorPayoutModel';
import { reconcileAuditorStakeForWallet, suspendAuditorRole } from '../services/auditorRoleActivationService';
import { confirmStakeWithdrawalPayout, createStakeWithdrawalPayout } from '../services/auditorPayoutCreationService';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import { withRpcTimeout } from '../utils/withRpcTimeout';

const logger = getLogger();
const LAST_LOG_INDEX_IN_BLOCK = Number.MAX_SAFE_INTEGER;
const LOGS_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_PROJECTION_FAILURES = 3;
let projectionTimer: ReturnType<typeof setInterval> | null = null;
let timeoutSweepTimer: ReturnType<typeof setInterval> | null = null;
let isProjectionRunning = false;

/** Kiểm tra log có thực sự ở sau checkpoint để replay block dở dang mà không chạy lại log cũ. */
function isLogAfterCheckpoint(log: ethers.Log, checkpoint: AuditorStakeEventCheckpoint): boolean {
  return log.blockNumber > checkpoint.lastProcessedBlock
    || (log.blockNumber === checkpoint.lastProcessedBlock && log.index > checkpoint.lastProcessedLogIndex);
}

/** Khởi tạo checkpoint từ block deploy cấu hình; không đoán mốc 0 để tránh quét chain không giới hạn. */
function createInitialCheckpoint(scope: AuditorStakeEventCheckpointScope): AuditorStakeEventCheckpoint | null {
  const deployBlock = Number.parseInt(process.env.AUDITOR_STAKING_DEPLOY_BLOCK ?? '', 10);
  if (!Number.isInteger(deployBlock) || deployBlock < 0) return null;
  return {
    ...scope,
    lastProcessedBlock: deployBlock,
    lastProcessedLogIndex: -1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/** Đọc staker từ topic indexed và ném lỗi có kiểm soát khi provider trả log không hợp lệ. */
function parseStakerAddress(log: ethers.Log): string {
  const stakerTopic = log.topics[1];
  if (!stakerTopic || !/^0x[0-9a-fA-F]{64}$/.test(stakerTopic)) {
    throw new Error('Event AuditorStaking thiếu topic staker hợp lệ.');
  }
  return ethers.getAddress(`0x${stakerTopic.slice(-40)}`);
}

/** Project một event AuditorStaking; quyền luôn do service reconcile quyết định thay vì worker giữ luật riêng. */
async function projectAuditorStakeLog(contract: ethers.Contract, log: ethers.Log): Promise<void> {
  const parsedLog = contract.interface.parseLog({ topics: log.topics, data: log.data });
  if (!parsedLog || !['Staked', 'UnstakeRequested', 'Withdrawn', 'Slashed'].includes(parsedLog.name)) {
    throw new Error('Không thể parse event AuditorStaking.');
  }
  const stakerAddress = parseStakerAddress(log);

  if (parsedLog.name === 'Slashed') {
    const user = await findUserByWalletAddress(stakerAddress);
    if (user?.role === 'auditor') {
      await suspendAuditorRole(user.id, 'SLASHED');
    }
    return;
  }

  if (parsedLog.name === 'Withdrawn') {
    const user = await findUserByWalletAddress(stakerAddress);
    const amount = parsedLog.args.amount as bigint;
    if (typeof amount !== 'bigint') {
      throw new Error('Event Withdrawn không có amount bigint hợp lệ.');
    }
    if (user?.role === 'auditor' && log.transactionHash) {
      const guard = await findAuditorStakeGuardByUserId(user.id);
      // Payout đang PAYOUT_IN_FLIGHT đã có hash nên được nhận diện trước khi tạo payout mới.
      let knownPayout = await findAuditorPayoutByOnchainTxHash(log.transactionHash);
      if (!knownPayout && guard?.walletLock === 'WITHDRAWING' && guard.lockRefId) {
        const confirmed = await confirmStakeWithdrawalPayout(user.id, guard.lockRefId, log.transactionHash);
        knownPayout = confirmed;
      }
      if (!knownPayout && guard?.walletLock === 'DEBT_SETTLING' && guard.lockRefId) {
        const settlement = await findAuditorDebtSettlementById(guard.lockRefId);
        if (settlement?.payoutId) {
          knownPayout = await linkAuditorPayoutToOnchainWithdrawal(settlement.payoutId, log.transactionHash);
        }
      }
      if (!knownPayout) {
        await createStakeWithdrawalPayout({
          auditorUserId: user.id,
          onchainTxHash: log.transactionHash,
          amount
        });
      }
    }
  }

  if (parsedLog.name === 'UnstakeRequested') {
    const user = await findUserByWalletAddress(stakerAddress);
    const guard = user ? await findAuditorStakeGuardByUserId(user.id) : null;
    if (user && guard?.walletLock === 'UNSTAKING' && guard.lockRefId) {
      await releaseAuditorUnstakeLock(user.id, guard.lockRefId);
    }
  }

  await reconcileAuditorStakeForWallet(stakerAddress);
}

/** Quét event đã đủ confirmation theo chunks bounded và checkpoint sau từng chunk hoàn tất. */
async function reconcileAuditorStakeEventsInternal(): Promise<void> {
  if (isProjectionRunning) return;
  isProjectionRunning = true;
  try {
    const provider = getReadOnlyAuditorStakingProvider();
    const contract = getReadOnlyAuditorStakingContract();
    const [network, currentBlock] = await Promise.all([
      withRpcTimeout(provider.getNetwork()),
      withRpcTimeout(provider.getBlockNumber())
    ]);
    const finalizedBlock = currentBlock - AUDITOR_STAKE_CONFIRMATION_BLOCKS;
    if (finalizedBlock < 0) return;

    const scope: AuditorStakeEventCheckpointScope = {
      chainId: network.chainId.toString(),
      contractAddress: getAuditorStakingContractAddressLowercase()
    };
    const checkpoint = await findAuditorStakeEventCheckpoint(scope) ?? createInitialCheckpoint(scope);
    if (!checkpoint || checkpoint.lastProcessedBlock > finalizedBlock) return;

    const eventTopics = ['Staked', 'UnstakeRequested', 'Withdrawn', 'Slashed'].map(eventName => {
      const eventFragment = contract.interface.getEvent(eventName);
      if (!eventFragment) throw new Error(`ABI AuditorStaking thiếu event ${eventName}.`);
      return eventFragment.topicHash;
    });

    for (let chunkStart = checkpoint.lastProcessedBlock; chunkStart <= finalizedBlock; chunkStart += AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST) {
      const chunkEnd = Math.min(chunkStart + AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST - 1, finalizedBlock);
      const logs = await withRpcTimeout(provider.getLogs({
        address: scope.contractAddress,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
        topics: [eventTopics]
      }), LOGS_TIMEOUT_MS);
      const seenWallets = new Set<string>();
      let lastSuccessfulLog: ethers.Log | null = null;
      let failedLog: ethers.Log | null = null;
      for (const log of logs.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index)) {
        if (!isLogAfterCheckpoint(log, checkpoint)) continue;
        try {
          const parsedLog = contract.interface.parseLog({ topics: log.topics, data: log.data });
          const stakerAddress = parseStakerAddress(log).toLowerCase();
          const isReconcileOnlyEvent = parsedLog?.name === 'Staked' || parsedLog?.name === 'UnstakeRequested';
          if (isReconcileOnlyEvent && seenWallets.has(stakerAddress)) continue;
          await projectAuditorStakeLog(contract, log);
          try {
            await clearAuditorStakeEventProjectionFailure({
              scope,
              transactionHash: log.transactionHash ?? 'UNKNOWN_HASH',
              logIndex: log.index
            });
          } catch (error) {
            logger.warn('Không thể xóa bộ đếm retry của event AuditorStaking đã project thành công.', {
              transactionHash: log.transactionHash ?? 'UNKNOWN_HASH',
              logIndex: log.index,
              errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
            });
          }
          if (isReconcileOnlyEvent) seenWallets.add(stakerAddress);
          lastSuccessfulLog = log;
        } catch (error) {
          const transactionHash = log.transactionHash ?? 'UNKNOWN_HASH';
          const errorMessage = sanitizeProviderError(error) ?? 'UNKNOWN_ERROR';
          const failure = await recordAuditorStakeEventProjectionFailure({
            scope,
            transactionHash,
            logIndex: log.index,
            blockNumber: log.blockNumber,
            errorMessage
          });
          if (failure.failureCount >= MAX_CONSECUTIVE_PROJECTION_FAILURES) {
            await markAuditorStakeEventAsDeadLetter({
              scope,
              transactionHash,
              logIndex: log.index,
              minimumFailureCount: MAX_CONSECUTIVE_PROJECTION_FAILURES
            });
            logger.error('Event AuditorStaking đã vào dead-letter; checkpoint sẽ tiếp tục để không nghẽn toàn lane.', {
              transactionHash,
              logIndex: log.index,
              failureCount: failure.failureCount,
              errorMessage
            });
            lastSuccessfulLog = log;
            continue;
          }
          // Dừng ở log lỗi đầu tiên để checkpoint không thể bỏ mất Withdrawn/Slashed có tác dụng phụ.
          failedLog = log;
          logger.warn('Không thể project event AuditorStaking; sẽ retry từ checkpoint an toàn.', {
            transactionHash: log.transactionHash ?? 'UNKNOWN_HASH',
            errorMessage,
            failureCount: failure.failureCount
          });
          break;
        }
      }
      if (failedLog) {
        const safeBlock = lastSuccessfulLog?.blockNumber ?? checkpoint.lastProcessedBlock;
        const safeLogIndex = lastSuccessfulLog?.index ?? checkpoint.lastProcessedLogIndex;
        await saveAuditorStakeEventCheckpoint(scope, safeBlock, safeLogIndex);
        return;
      }
      await saveAuditorStakeEventCheckpoint(scope, chunkEnd, LAST_LOG_INDEX_IN_BLOCK);
    }
  } catch (error) {
    logger.warn('AuditorStaking projector chưa sẵn sàng hoặc reconcile thất bại.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  } finally {
    isProjectionRunning = false;
  }
}

/** Dọn intent quá hạn sau một lần reconcile cuối để không đánh fail người dùng đã cọc nhưng worker lỡ nhịp. */
async function sweepExpiredAuditorStakeIntentsInternal(): Promise<void> {
  const cutoff = new Date(Date.now() - AUDITOR_STAKE_INTENT_TIMEOUT_MS);
  const expiredIntents = await findExpiredAuditorStakeIntents(cutoff);
  for (const intent of expiredIntents) {
    try {
      await reconcileAuditorStakeForWallet(intent.walletAddress);
      const user = await findUserById(intent.userId);
      if (user?.accountStatus === 'ACTIVE' && user.role === 'auditor') continue;
      await updateAuditorStakeIntent({
        ...intent,
        status: 'FAILED',
        failureReason: 'VERIFICATION_TIMEOUT_24H',
        updatedAt: new Date()
      });
    } catch (error) {
      logger.warn('Không thể dọn intent AuditorStaking quá hạn.', {
        intentId: intent.id,
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }
}

/** Chạy projector trong worker context để log có correlation ID ổn định. */
async function reconcileAuditorStakeEvents(): Promise<void> {
  await runWithWorkerContext('auditor-stake-projection', reconcileAuditorStakeEventsInternal);
}

/** Khởi động projector và timeout sweep; thiếu cấu hình chỉ ghi warning trong chu kỳ thay vì làm server crash. */
export function startAuditorStakeEventProjectionWorker(): void {
  if (projectionTimer) return;
  if (!process.env.AUDITOR_STAKING_ADDRESS?.trim()) {
    logger.warn('Chưa cấu hình AUDITOR_STAKING_ADDRESS; AuditorStaking projector đã tắt.');
    return;
  }
  const deployBlock = Number.parseInt(process.env.AUDITOR_STAKING_DEPLOY_BLOCK ?? '', 10);
  if (!Number.isInteger(deployBlock) || deployBlock < 0) {
    logger.warn('Chưa cấu hình AUDITOR_STAKING_DEPLOY_BLOCK hợp lệ; AuditorStaking projector đã tắt.');
    return;
  }
  void logAuditorStakingSignerAddressOnce();
  void reconcileAuditorStakeEvents();
  projectionTimer = setInterval(() => void reconcileAuditorStakeEvents(), AUDITOR_STAKE_POLL_INTERVAL_MS);
  timeoutSweepTimer = setInterval(() => void sweepExpiredAuditorStakeIntentsInternal(), AUDITOR_STAKE_TIMEOUT_SWEEP_INTERVAL_MS);
}

/** Dừng toàn bộ timer để graceful shutdown và test isolated không giữ event loop. */
export function stopAuditorStakeEventProjectionWorker(): void {
  if (projectionTimer) clearInterval(projectionTimer);
  if (timeoutSweepTimer) clearInterval(timeoutSweepTimer);
  projectionTimer = null;
  timeoutSweepTimer = null;
}

/** Reset module state chỉ dành cho test worker độc lập. */
export function __resetAuditorStakeEventProjectionWorkerState(): void {
  stopAuditorStakeEventProjectionWorker();
  isProjectionRunning = false;
}

/** Các hook nội bộ giúp test worker kiểm tra retry và dead-letter mà không mở timer thật. */
export const __auditorStakeEventProjectionWorkerTestHooks = { reconcileAuditorStakeEventsInternal };
