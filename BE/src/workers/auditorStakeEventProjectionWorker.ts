import { ethers } from 'ethers';
import {
  getAuditorStakingContractAddressLowercase,
  logAuditorStakingSignerAddressOnce,
  getReadOnlyAuditorStakingContract,
  getReadOnlyAuditorStakingFallbackProvider,
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
const LOGS_RETRY_DELAYS_MS = [250, 1_000] as const;
const PRIMARY_RPC_FALLBACK_COOLDOWN_MS = 5 * 60_000;
const MAX_CONSECUTIVE_PROJECTION_FAILURES = 3;
let projectionTimer: ReturnType<typeof setInterval> | null = null;
let timeoutSweepTimer: ReturnType<typeof setInterval> | null = null;
let isProjectionRunning = false;
let primaryRpcFallbackCooldownUntilMs = 0;

/** Kiểm tra object lỗi RPC trước khi đọc các field không được type bởi ethers. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Tìm thông điệp lỗi tạm thời trong payload lồng nhau mà ethers tạo từ HTTP response của RPC. */
function containsTemporaryInternalError(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof value === 'string') return value.toLowerCase().includes('temporary internal error');
  if (!isRecord(value)) return false;
  return Object.values(value).some(nestedValue => containsTemporaryInternalError(nestedValue, depth + 1));
}

/** Nhận diện lỗi RPC tạm thời dù ethers bọc code 19 trong error hoặc HTTP 500 trong info.responseBody. */
function isTemporaryGetLogsError(error: unknown): boolean {
  if (!isRecord(error) || !containsTemporaryInternalError(error)) return false;

  const providerError = isRecord(error.error) ? error.error : null;
  const errorCode = providerError?.code;
  if (errorCode === 19 || errorCode === '19') return true;

  const errorMessage = error.message;
  return typeof errorMessage === 'string'
    && errorMessage.toLowerCase().includes('server response 500');
}

/** Chờ backoff ngắn giữa các lần gọi lại eth_getLogs để tránh dồn tải vào RPC provider. */
function waitForGetLogsRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** Lấy log AuditorStaking với retry hữu hạn chỉ cho phản hồi tạm thời đã biết của RPC provider. */
async function getAuditorStakeLogsFromProvider(
  provider: ethers.JsonRpcProvider,
  filter: ethers.Filter
): Promise<ethers.Log[]> {
  for (let retryAttempt = 0; ; retryAttempt += 1) {
    try {
      return await withRpcTimeout(provider.getLogs(filter), LOGS_TIMEOUT_MS);
    } catch (error) {
      const retryDelayMs = LOGS_RETRY_DELAYS_MS[retryAttempt];
      if (!isTemporaryGetLogsError(error) || retryDelayMs === undefined) throw error;

      logger.warn('RPC eth_getLogs AuditorStaking lỗi tạm thời; sẽ retry cùng checkpoint.', {
        retryAttempt: retryAttempt + 1,
        retryDelayMs,
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
      await waitForGetLogsRetry(retryDelayMs);
    }
  }
}

/** Đọc log từ fallback sau khi xác thực endpoint vẫn đang kết nối đúng blockchain của primary. */
async function getAuditorStakeLogsFromFallback(
  fallbackProvider: ethers.JsonRpcProvider,
  expectedChainId: bigint,
  filter: ethers.Filter
): Promise<ethers.Log[]> {
  const fallbackNetwork = await withRpcTimeout(fallbackProvider.getNetwork());
  if (fallbackNetwork.chainId !== expectedChainId) {
    throw new Error('AUDITOR_STAKING_RPC_FALLBACK_URL đang trỏ tới blockchain khác BLOCKCHAIN_CHAIN_ID.');
  }
  return getAuditorStakeLogsFromProvider(fallbackProvider, filter);
}

/** Dùng fallback trong cooldown sau lỗi tạm thời để không liên tục dồn retry vào primary đang quá tải. */
async function getAuditorStakeLogs(
  provider: ethers.JsonRpcProvider,
  fallbackProvider: ethers.JsonRpcProvider | null,
  expectedChainId: bigint,
  filter: ethers.Filter
): Promise<ethers.Log[]> {
  if (fallbackProvider && Date.now() < primaryRpcFallbackCooldownUntilMs) {
    try {
      return await getAuditorStakeLogsFromFallback(fallbackProvider, expectedChainId, filter);
    } catch (error) {
      if (!isTemporaryGetLogsError(error)) throw error;
      // Fallback tạm thời lỗi thì mở lại primary ngay trong lần chạy này để không mất đường đọc log duy nhất.
      primaryRpcFallbackCooldownUntilMs = 0;
    }
  }

  try {
    return await getAuditorStakeLogsFromProvider(provider, filter);
  } catch (error) {
    if (!isTemporaryGetLogsError(error) || !fallbackProvider) throw error;

    logger.warn('RPC eth_getLogs AuditorStaking primary đã hết retry; chuyển sang fallback.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    const logs = await getAuditorStakeLogsFromFallback(fallbackProvider, expectedChainId, filter);
    primaryRpcFallbackCooldownUntilMs = Date.now() + PRIMARY_RPC_FALLBACK_COOLDOWN_MS;
    return logs;
  }
}

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
    const fallbackProvider = getReadOnlyAuditorStakingFallbackProvider();
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
      const logs = await getAuditorStakeLogs(
        provider,
        fallbackProvider,
        network.chainId,
        {
          address: scope.contractAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [eventTopics]
        }
      );
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
  primaryRpcFallbackCooldownUntilMs = 0;
}

/** Các hook nội bộ giúp test worker kiểm tra retry và dead-letter mà không mở timer thật. */
export const __auditorStakeEventProjectionWorkerTestHooks = { reconcileAuditorStakeEventsInternal };
